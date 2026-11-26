import type { ModelIO } from "./model-io.ts";
import { Buffer } from "node:buffer";
import type { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { Tool } from "../agent/tools.ts";

export type Budget = {
  contextWindow: number;
  outputTokens: number;
  summaryOutputTokens: number;
  safetyTokens: number;
  toolTokens: number;
  messageLimit: number;
  compactAt: number;
};

// 教学估算，不是模型 tokenizer；JSON 包装和元数据也会被计入。
export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

export function estimateMessages(messages: BaseMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTextTokens(JSON.stringify(message.toDict())) + 8;
  }
  return total;
}

export function createBudget(
  tools: readonly Tool[],
  model?: { contextWindow: number; maxTokens: number },
  settings: { contextWindow?: number; compactAt?: number } = {},
): Budget {
  const configuredWindow = settings.contextWindow ?? 32768;
  const contextWindow = Math.min(configuredWindow, model?.contextWindow ?? configuredWindow);
  const outputTokens = model ? Math.min(4096, model.maxTokens, Math.floor(contextWindow / 3)) : 4096;
  const summaryOutputTokens = Math.min(2048, outputTokens);
  const safetyTokens = model ? Math.min(2048, Math.floor(contextWindow / 8)) : 2048;
  const declarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.schema),
  }));
  const toolTokens = estimateTextTokens(JSON.stringify(declarations));
  const messageLimit = contextWindow - outputTokens - safetyTokens - toolTokens;
  if (messageLimit < 1024) {
    throw new Error("工具声明和输出预留后，消息预算不足");
  }
  const compactAt = settings.compactAt ?? Math.floor(messageLimit * 0.75);
  if (compactAt > messageLimit) throw new Error(`压缩阈值 ${compactAt} 超出消息预算 ${messageLimit}`);
  return {
    contextWindow, outputTokens, summaryOutputTokens, safetyTokens,
    toolTokens, messageLimit, compactAt,
  };
}

export function withBudget(model: ModelIO, budget: Budget, debug: boolean, log: (text: string) => void): ModelIO {
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
