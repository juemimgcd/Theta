import { buildContext } from "./context.ts";
import type { CheckpointEntry, MessageEntry, SessionEntry } from "./session-types.ts";

export function inspectRecovery(
  entries: SessionEntry[],
  sessionId: string,
): CheckpointEntry {
  let latest: CheckpointEntry | undefined;
  let lastMessage: MessageEntry | undefined;
  let turns = 0;
  let taskMaxTurns: number | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === "message") {
      lastMessage = entry;
      if (entry.message.type === "human") {
        turns = 0;
        taskMaxTurns = undefined;
      } else if (entry.message.type === "ai") {
        turns += 1;
      }
    } else if (entry.type === "checkpoint") {
      if (entry.sessionId !== sessionId || entry.afterEntryId !== entries[index - 1]?.id) {
        throw new Error(`检查点的会话或历史位置不匹配：${entry.id}`);
      }
      // 历史即使后来配齐，也不能让早先未配齐处的检查点变得有效。
      buildContext(entries.slice(0, index));
      if (entry.turns !== turns || entry.turns > entry.maxTurns) {
        throw new Error(`检查点轮数与实际消息不一致：${entry.id}`);
      }
      if (taskMaxTurns !== undefined && taskMaxTurns !== entry.maxTurns) {
        throw new Error(`同一任务的轮数上限发生变化：${entry.id}`);
      }
      taskMaxTurns = entry.maxTurns;
      if (entry.next === "model") {
        if (turns < 1 || turns >= entry.maxTurns || lastMessage?.message.type !== "tool") {
          throw new Error(`检查点不满足继续请求模型的条件：${entry.id}`);
        }
      } else {
        const type = lastMessage?.message.type;
        const initial = turns === 0 && index === 1 && type === "system";
        if (!initial && (turns < 1 || (type !== "ai" && type !== "tool"))) {
          throw new Error(`检查点不满足等待新输入的条件：${entry.id}`);
        }
      }
      latest = entry;
    }
  }
  if (latest === undefined) {
    throw new Error("会话没有检查点，不能自动继续；保留原文件并人工核对");
  }
  const tail = entries.at(-1);
  if (tail?.id !== latest.id) {
    throw new Error(
      `检查点 ${latest.id} 后还有记录，末条为 ${tail?.type} ${tail?.id}。` +
      "不能回退或忽略这些记录；工具副作用可能已经发生，不会自动重放。",
    );
  }
  return structuredClone(latest);
}
