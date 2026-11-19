import { AIMessage, type AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { estimateMessages, type Budget } from "./budget.ts";
import type { Tool } from "./tools.ts";

export type ReplyMode = "stream" | "complete";

export type ModelIO = {
  request(messages: BaseMessage[], signal: AbortSignal, onText?: (delta: string) => Promise<void>): Promise<AIMessage>;
  summarize(messages: BaseMessage[], signal: AbortSignal): Promise<AIMessage>;
};

const argumentObject = z.record(z.string(), z.unknown());

export function createModelIO(
  modelName: string, apiKey: string, tools: readonly Tool[], budget: Budget, baseURL?: string,
): ModelIO {
  const options = {
    model: modelName, apiKey, configuration: { baseURL }, useResponsesApi: false,
    maxRetries: 0, timeout: 60_000,
  };
  const chat = new ChatOpenAI({ ...options, maxTokens: budget.outputTokens }).bindTools(
    tools.map(({ name, description, schema }) => ({ name, description, schema })),
  );
  const summarizer = new ChatOpenAI({ ...options, maxTokens: budget.summaryOutputTokens });
  return {
    async request(messages, signal, onText) {
      if (!onText) {
        const response = await chat.invoke(messages, { signal });
        // 部分兼容服务省略 usage，LangChain 此时仍可能返回缺少计数的用量对象。
        const usage = response.usage_metadata;
        return new AIMessage({
          content: response.content, id: response.id, tool_calls: response.tool_calls,
          invalid_tool_calls: response.invalid_tool_calls, additional_kwargs: response.additional_kwargs,
          response_metadata: response.response_metadata,
          usage_metadata: usage?.input_tokens != null && usage.output_tokens != null && usage.total_tokens != null
            ? usage : undefined,
        });
      }
      const stream = await chat.stream(messages, { signal });
      let full: AIMessageChunk | undefined;
      for await (const chunk of stream) {
        if (chunk.text) await onText(chunk.text);
        full = full ? full.concat(chunk) : chunk;
      }
      signal.throwIfAborted();
      if (!full) throw new Error("模型返回了空响应流，本轮未提交。");

      // LangChain can parse partial JSON while streaming. Only accept the complete argument string.
      const calls = (full.tool_call_chunks ?? []).map(part => {
        try {
          return { id: part.id, name: part.name ?? "", args: argumentObject.parse(JSON.parse(part.args ?? "")) };
        } catch (cause) {
          throw new Error(`工具 ${part.name ?? part.index} 的参数不完整或不是对象：${String(cause)}`, { cause });
        }
      });
      return new AIMessage({
        content: full.content, tool_calls: calls, id: full.id, additional_kwargs: full.additional_kwargs,
        response_metadata: full.response_metadata, usage_metadata: full.usage_metadata,
      });
    },

    async summarize(messages, signal) {
      return summarizer.invoke(messages, { signal });
    },
  };
}

export function withBudget(model: ModelIO, budget: Budget, log: (text: string) => void): ModelIO {
  const debug = (process.env.THETA_DEBUG_CONTEXT ?? process.env.ALPHA_DEBUG_CONTEXT) === "1";
  let requestNumber = 0;
  return {
    async request(messages, signal, onText) {
      const size = estimateMessages(messages);
      if (size > budget.messageLimit) throw new Error(`主请求估算 ${size} tokens，超出消息预算 ${budget.messageLimit}`);
      if (debug) log(`[context] 第 ${++requestNumber} 次请求，${messages.length} 条消息\n${JSON.stringify(messages.map(m => m.toDict()), null, 2)}`);
      return model.request(messages, signal, onText);
    },
    async summarize(messages, signal) {
      const limit = budget.contextWindow - budget.summaryOutputTokens - budget.safetyTokens;
      const size = estimateMessages(messages);
      if (size > limit) throw new Error(`摘要输入估算 ${size} tokens，超出预算 ${limit}`);
      const result = await model.summarize(messages, signal);
      if (debug) log(`[summary usage] ${JSON.stringify(result.usage_metadata)}`);
      return result;
    },
  };
}
