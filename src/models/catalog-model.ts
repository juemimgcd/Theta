import type { Api, AssistantMessage, Message, Model, Tool as PiTool } from "@earendil-works/pi-ai";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelIO } from "./model-io.ts";
import type { Budget } from "./budget.ts";
import type { Tool } from "../agent/tools.ts";

// Text and tool arguments already live in Theta's messages. Keep their order and the
// provider signatures separately so resumed tool calls can replay signed reasoning.
const replaySchema = z.object({
  provider: z.string(), model: z.string(), api: z.string(), timestamp: z.number(),
  responseId: z.string().optional(), responseModel: z.string().optional(),
  parts: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), length: z.number().int().nonnegative(), textSignature: z.string().optional() }),
    z.object({ type: z.literal("toolCall"), thoughtSignature: z.string().optional(), namespace: z.string().optional() }),
    z.object({ type: z.literal("thinking"), thinking: z.string(), thinkingSignature: z.string().optional(), redacted: z.boolean().optional() }),
  ])),
});

function history(message: BaseMessage): Message {
  const timestamp = 0;
  if (message instanceof SystemMessage) return { role: "system", content: message.text, timestamp };
  if (message instanceof HumanMessage) return { role: "user", content: message.text, timestamp };
  if (message instanceof ToolMessage) return {
    role: "toolResult", toolCallId: message.tool_call_id, toolName: message.name ?? "",
    content: [{ type: "text", text: message.text }], isError: message.status === "error", timestamp,
  };
  if (!(message instanceof AIMessage)) throw new Error(`无法转换会话消息 ${message.type}`);
  const calls = (message.tool_calls ?? []).map(call => ({
    type: "toolCall" as const, id: call.id!, name: call.name, arguments: call.args,
  }));
  let content: AssistantMessage["content"] = [{ type: "text", text: message.text }, ...calls];
  const saved = replaySchema.optional().parse(message.response_metadata.thetaReplay);
  if (saved) {
    let offset = 0;
    let call = 0;
    content = saved.parts.map(part => {
      if (part.type === "thinking") return part;
      if (part.type === "toolCall") return { ...calls[call++], ...part };
      const text = message.text.slice(offset, offset + part.length);
      offset += part.length;
      return { type: "text", text, textSignature: part.textSignature };
    });
  }
  return {
    role: "assistant", api: saved?.api ?? "openai-completions", provider: saved?.provider ?? "theta-legacy",
    model: saved?.model ?? "legacy", timestamp: saved?.timestamp ?? timestamp, responseId: saved?.responseId,
    responseModel: saved?.responseModel, content, stopReason: calls.length ? "toolUse" : "stop",
    usage: { input: message.usage_metadata?.input_tokens ?? 0, output: message.usage_metadata?.output_tokens ?? 0,
      totalTokens: message.usage_metadata?.total_tokens ?? 0, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

export function createCatalogIO(
  { runtime, model }: { runtime: ModelRuntime; model: Model<Api> }, tools: readonly Tool[], budget: Budget,
): ModelIO {
  const declarations = tools.map(t => ({ name: t.name, description: t.description, parameters: z.toJSONSchema(t.schema) }));
  async function request(
    messages: BaseMessage[], signal: AbortSignal, maxTokens: number, tools?: PiTool[], onText?: (text: string) => Promise<void>,
  ): Promise<AIMessage> {
    const [first, ...rest] = messages;
    const context = first instanceof SystemMessage
      ? { systemPrompt: first.text, messages: rest.map(history), tools }
      : { messages: messages.map(history), tools };
    const options = { signal, maxTokens, timeoutMs: 60_000, maxRetries: 0 };
    const stream = runtime.streamSimple(model, context, options);
    if (onText) {
      for await (const event of stream) if (event.type === "text_delta") await onText(event.delta);
    }
    const result = await stream.result();
    signal.throwIfAborted();
    if (result.stopReason !== "stop" && result.stopReason !== "toolUse") {
      throw new Error(`${model.provider}/${model.id}：${result.errorMessage ?? result.stopReason}`);
    }
    const calls = result.content.filter(p => p.type === "toolCall").map(call => {
      if (call.argumentsError) throw new Error(`工具 ${call.name} 参数不完整：${call.argumentsError}`);
      return { id: call.id, name: call.name, args: call.arguments };
    });
    const { api, provider, model: id, responseId, responseModel, timestamp, usage } = result;
    const parts = result.content.map(part => {
      if (part.type === "text") return { type: part.type, length: part.text.length, textSignature: part.textSignature };
      if (part.type === "toolCall") return { type: part.type, thoughtSignature: part.thoughtSignature, namespace: part.namespace };
      return part;
    });
    return new AIMessage({
      content: result.content.filter(p => p.type === "text").map(p => p.text).join(""), tool_calls: calls,
      response_metadata: { finish_reason: result.stopReason === "toolUse" ? "tool_calls" : "stop",
        thetaReplay: { api, provider, model: id, responseId, responseModel, timestamp, parts } },
      usage_metadata: { input_tokens: usage.input + usage.cacheRead + usage.cacheWrite, output_tokens: usage.output, total_tokens: usage.totalTokens },
    });
  }
  return {
    request: (messages, signal, onText) => request(messages, signal, budget.outputTokens, declarations, onText),
    summarize: (messages, signal) => request(messages, signal, budget.summaryOutputTokens),
  };
}
