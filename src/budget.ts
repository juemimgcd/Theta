import { Buffer } from "node:buffer";
import type { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { Tool } from "./tools.ts";

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

export function createBudget(tools: readonly Tool[], model?: { contextWindow: number; maxTokens: number }): Budget {
  const configuredWindow = z.coerce.number().int().min(8192).parse(
    process.env.THETA_CONTEXT_WINDOW ?? process.env.ALPHA_CONTEXT_WINDOW ?? "32768",
  );
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
  const compactAt = z.coerce.number().int().positive().max(messageLimit).parse(
    process.env.THETA_COMPACT_AT ?? process.env.ALPHA_COMPACT_AT ?? String(Math.floor(messageLimit * 0.75)),
  );
  return {
    contextWindow, outputTokens, summaryOutputTokens, safetyTokens,
    toolTokens, messageLimit, compactAt,
  };
}
