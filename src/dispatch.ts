import { ToolMessage } from "@langchain/core/messages";
import type { Hook, ToolStatus } from "./hooks.ts";
import { truncateOutput } from "./tools.ts";
import type { Tool, ToolCall } from "./tools.ts";

export type ToolExecution = {
  message: ToolMessage;
  status: ToolStatus;
  raw: string;
};

export async function executeTool(
  call: ToolCall,
  tools: readonly Tool[],
  hooks: readonly Hook[],
  cwd: string,
  signal: AbortSignal,
): Promise<ToolExecution> {
  let status: ToolStatus = "success";
  let raw = "";

  try {
    signal.throwIfAborted();
    const tool = tools.find((item) => item.name === call.name);
    if (tool === undefined) {
      throw new Error(`未知工具：${call.name}`);
    }
    const prepared = tool.prepare(call.args);

    for (const hook of hooks) {
      const reason = await hook.beforeTool?.({
        id: call.id,
        name: call.name,
        args: structuredClone(prepared.args),
        cwd: cwd,
      }, signal);
      signal.throwIfAborted();

      if (typeof reason === "string" && reason.trim() !== "") {
        status = "denied";
        raw = `工具被拒绝：${reason}`;
        break;
      }
    }

    if (status !== "denied") {
      raw = await prepared.execute(cwd, signal);
    }
  } catch (error: unknown) {
    status = "error";
    const detail = error instanceof Error ? error.message : String(error);
    raw = `工具调用未成功：${detail}`;
  }

  let content = raw;
  for (const hook of hooks) {
    try {
      const replacement = await hook.afterTool?.({
        id: call.id,
        name: call.name,
        status: status,
        raw: raw,
        content: content,
      }, signal);
      if (typeof replacement === "string") {
        content = replacement;
      }
    } catch (error: unknown) {
      status = "error";
      const detail = error instanceof Error ? error.message : String(error);
      content = `工具结果处理失败：${detail}\n原始结果：\n${raw}`;
      break;
    }
  }

  if (status !== "success") {
    content = `[工具状态：${status}]\n${content}`;
  }
  const message = new ToolMessage({
    content: truncateOutput(content),
    tool_call_id: call.id,
    name: call.name,
    status: status === "success" ? "success" : "error",
  });
  return { message: message, status: status, raw: raw };
}
