import type { AIMessage, BaseMessage } from "@langchain/core/messages";

export type ReplyMode = "stream" | "complete";

export type ModelIO = {
  request(messages: BaseMessage[], signal: AbortSignal, onText?: (delta: string) => Promise<void>): Promise<AIMessage>;
  summarize(messages: BaseMessage[], signal: AbortSignal): Promise<AIMessage>;
};
