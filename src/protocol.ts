import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { toolCallSchema } from "./tools.ts";
import type { ToolCall } from "./tools.ts";

export function responseCalls(message: AIMessage): ToolCall[] {
  const invalidCalls = message.invalid_tool_calls ?? [];
  if (invalidCalls.length > 0) {
    throw new Error("模型返回了无法解析的工具调用，本轮不执行工具");
  }

  const reason: unknown = message.response_metadata.finish_reason;
  if (reason !== undefined && reason !== "stop" && reason !== "tool_calls") {
    throw new Error(`模型响应未正常完成：${String(reason)}`);
  }
  if (typeof message.content !== "string") {
    throw new Error("当前适配器只处理文本和函数调用，请选择相应的模型接口");
  }

  const calls: ToolCall[] = [];
  const ids = new Set<string>();

  for (const call of message.tool_calls ?? []) {
    const checkedCall = toolCallSchema.parse(call);
    if (ids.has(checkedCall.id)) {
      throw new Error(`同一响应中出现重复的工具调用 ID：${checkedCall.id}`);
    }

    ids.add(checkedCall.id);
    calls.push(checkedCall);
  }

  if (reason === "tool_calls" && calls.length === 0) {
    throw new Error("模型声明要调用工具，但没有返回有效调用");
  }
  if (reason === "stop" && calls.length > 0) {
    throw new Error("模型的结束原因与工具调用不一致");
  }
  if (calls.length === 0 && message.content.trim() === "") {
    throw new Error("模型既没有回答，也没有请求工具");
  }

  return calls;
}

export function validateHistory(messages: BaseMessage[]): void {
  const pendingIds = new Set<string>();

  for (const message of messages) {
    if (message instanceof ToolMessage) {
      if (!pendingIds.has(message.tool_call_id)) {
        throw new Error("历史中出现了没有对应调用的工具结果");
      }
      pendingIds.delete(message.tool_call_id);
      continue;
    }

    if (pendingIds.size > 0) {
      throw new Error("工具结果还没有补齐，就出现了另一条普通消息");
    }

    if (message instanceof AIMessage) {
      for (const call of message.tool_calls ?? []) {
        if (typeof call.id !== "string" || call.id.trim() === "" || pendingIds.has(call.id)) {
          throw new Error("历史中的工具调用 ID 无效或重复");
        }
        pendingIds.add(call.id);
      }
    }
  }

  if (pendingIds.size > 0) {
    throw new Error("工具结果还没有补齐，不能请求模型");
  }
}
