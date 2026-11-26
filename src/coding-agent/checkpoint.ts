import { projectContext } from "./context.ts";
import type { CheckpointEntry, MessageEntry, SessionEntry } from "./session-types.ts";

export type CheckpointCursor = {
  checkpoint: CheckpointEntry;
  nextIndex: number;
  lastMessageType: MessageEntry["message"]["type"];
};

// end 是检查点在记录序列中的位置，追加前等于当前记录数。
export function checkCheckpoint(
  entries: SessionEntry[], end: number, checkpoint: CheckpointEntry, sessionId: string,
  previous?: CheckpointCursor,
): CheckpointCursor {
  let turns = previous?.checkpoint.turns ?? 0;
  let maxTurns = previous?.checkpoint.maxTurns;
  let lastMessageType = previous?.lastMessageType;
  for (let i = previous?.nextIndex ?? 0; i < end; i++) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    lastMessageType = entry.message.type;
    if (lastMessageType === "human") {
      turns = 0;
      maxTurns = undefined;
    } else if (lastMessageType === "ai") {
      turns++;
    }
  }

  if (checkpoint.sessionId !== sessionId || checkpoint.afterEntryId !== entries[end - 1]?.id) {
    throw new Error(`检查点的会话或历史位置不匹配：${checkpoint.id}`);
  }
  if (checkpoint.turns !== turns || turns > checkpoint.maxTurns) {
    throw new Error(`检查点轮数与实际消息不一致：${checkpoint.id}`);
  }
  if (maxTurns !== undefined && maxTurns !== checkpoint.maxTurns) {
    throw new Error(`同一任务的轮数上限发生变化：${checkpoint.id}`);
  }
  if (checkpoint.next === "model") {
    if (turns < 1 || turns >= checkpoint.maxTurns || lastMessageType !== "tool") {
      throw new Error(`检查点不满足继续请求模型的条件：${checkpoint.id}`);
    }
  } else if (!(turns === 0 && end === 1 && lastMessageType === "system")) {
    if (turns < 1 || (lastMessageType !== "ai" && lastMessageType !== "tool")) {
      throw new Error(`检查点不满足等待新输入的条件：${checkpoint.id}`);
    }
  }
  return { checkpoint, nextIndex: end + 1, lastMessageType };
}

export function recoverCheckpointCursor(entries: SessionEntry[], sessionId: string): CheckpointCursor {
  let latest: CheckpointCursor | undefined;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "checkpoint") latest = checkCheckpoint(entries, i, entry, sessionId, latest);
  }
  if (!latest) {
    throw new Error("会话没有检查点，不能自动继续；保留原文件并人工核对");
  }
  if (latest.nextIndex !== entries.length) {
    const tail = entries.at(-1);
    throw new Error(
      `检查点 ${latest.checkpoint.id} 后还有记录，末条为 ${tail?.type} ${tail?.id}。` +
      "不能回退或忽略这些记录；工具副作用可能已经发生，不会自动重放。",
    );
  }
  projectContext(entries);
  return latest;
}

export function inspectRecovery(entries: SessionEntry[], sessionId: string): CheckpointEntry {
  return { ...recoverCheckpointCursor(entries, sessionId).checkpoint };
}
