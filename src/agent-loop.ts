import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { executeTool } from "./dispatch.ts";
import type { EmitEvent, RunResult } from "./events.ts";
import { copyMessages } from "./hooks.ts";
import type { Hook, TurnInfo } from "./hooks.ts";
import type { ModelIO, ReplyMode } from "./model-io.ts";
import { responseCalls, validateHistory } from "./protocol.ts";
import type { Tool } from "./tools.ts";

export type PrepareContext = (signal: AbortSignal) => Promise<BaseMessage[]>;

export async function runLoop(
  prepareContext: PrepareContext,
  model: ModelIO,
  tools: readonly Tool[],
  hooks: readonly Hook[],
  cwd: string,
  maxTurns: number,
  signal: AbortSignal,
  emit: EmitEvent,
  completedTurns: number = 0,
  replyMode: ReplyMode = "stream",
): Promise<RunResult> {
  for (let turn = completedTurns + 1; turn <= maxTurns; turn += 1) {
    signal.throwIfAborted();
    let requestMessages = await prepareContext(signal);
    signal.throwIfAborted();

    for (const hook of hooks) {
      const replacement = await hook.beforeModel?.(requestMessages, signal);
      if (replacement !== undefined) {
        requestMessages = replacement;
      }
    }
    signal.throwIfAborted();
    validateHistory(requestMessages);

    const response = await model.request(requestMessages, signal,
      replyMode === "stream" ? text => emit({ type: "text_delta", text }) : undefined);
    signal.throwIfAborted();
    const calls = responseCalls(response);

    for (const hook of hooks) {
      if (hook.afterModel !== undefined) {
        const snapshot = copyMessages([response])[0];
        if (!(snapshot instanceof AIMessage)) {
          throw new Error("模型消息副本没有恢复为 AIMessage");
        }
        await hook.afterModel(snapshot, signal);
      }
    }
    signal.throwIfAborted();
    await emit({ type: "message_end", message: response });

    for (const call of calls) {
      await emit({ type: "tool_start", callId: call.id, name: call.name });
      const execution = await executeTool(call, tools, hooks, cwd, signal);
      await emit({ type: "message_end", message: execution.message });
      await emit({
        type: "tool_end",
        callId: call.id,
        name: call.name,
        status: execution.status,
        raw: execution.raw,
        content: execution.message.text,
      });
    }

    const info: TurnInfo = {
      turn: turn,
      toolCount: calls.length,
      hasAnswer: calls.length === 0,
    };
    await emit({ type: "turn_end", ...info });
    if (signal.aborted) {
      // All tool results have been recorded, including calls skipped after cancellation.
      await emit({ type: "run_boundary", next: "input", turns: turn, maxTurns });
      signal.throwIfAborted();
    }

    for (const hook of hooks) {
      const reason = await hook.afterTurn?.({ ...info }, signal);
      signal.throwIfAborted();
      if (typeof reason === "string" && reason.trim() !== "") {
        await emit({ type: "run_boundary", next: "input", turns: turn, maxTurns });
        return { status: "stopped", reason: reason, turns: turn };
      }
    }

    if (calls.length === 0) {
      await emit({ type: "run_boundary", next: "input", turns: turn, maxTurns });
      return { status: "completed", answer: response.text, turns: turn };
    }
    // 最大轮数耗尽时只能接收新任务；恢复不能偷偷获得额外轮数。
    const next = turn < maxTurns ? "model" : "input";
    await emit({ type: "run_boundary", next, turns: turn, maxTurns });
    signal.throwIfAborted();
  }

  throw new Error(`已达到 ${maxTurns} 次模型请求的上限，本次任务尚未得到最终回答`);
}
