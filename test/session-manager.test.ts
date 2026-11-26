import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { SessionManager } from "../src/coding-agent/session-manager.ts";
import type { SessionRecord } from "../src/coding-agent/session-types.ts";
import { workspaceTest } from "./workspace.ts";

async function start(cwd: string) {
  const manager = await SessionManager.create(cwd, [new SystemMessage("项目规则")]);
  await manager.appendCheckpoint("input", 0, 3);
  return manager;
}

function requestReads(...ids: string[]) {
  return new AIMessage({ content: "", tool_calls: ids.map(id => ({ id, name: "read", args: { path: id } })) });
}

function result(id: string) {
  return new ToolMessage({ content: "已读取", tool_call_id: id, name: "read", status: "success" });
}

workspaceTest("只有全部工具结果配齐才能写检查点，失败后可以补齐再写", async cwd => {
  const session = await start(cwd);
  await session.appendMessage(new HumanMessage("读取两个文件"));
  await session.appendMessage(requestReads("a", "b"));
  await session.appendMessage(result("b"));
  const before = await readFile(session.filePath, "utf8");
  await assert.rejects(session.appendCheckpoint("model", 1, 3), /工具结果还没有补齐/);
  assert.equal(await readFile(session.filePath, "utf8"), before);

  await session.appendMessage(result("a"));
  await session.appendCheckpoint("model", 1, 3);
  const restored = await SessionManager.load(session.filePath, cwd);
  assert.deepEqual(restored.checkpoint, session.checkpoint);
  assert.equal(restored.checkpoint?.next, "model");

  await restored.appendMessage(new AIMessage("已完成"));
  await assert.rejects(restored.appendCheckpoint("input", 1, 3), /轮数与实际消息不一致/);
  await assert.rejects(restored.appendCheckpoint("input", 2, 8), /轮数上限发生变化/);
  await restored.appendCheckpoint("input", 2, 3);
  await restored.appendMessage(new HumanMessage("新任务"));
  await restored.appendMessage(new AIMessage("新回答"));
  await restored.appendCheckpoint("input", 1, 8);
  assert.deepEqual((await SessionManager.load(session.filePath, cwd)).checkpoint, restored.checkpoint);
});

workspaceTest("加载历史时，后续补齐的工具结果不能修复更早的非法检查点", async cwd => {
  const session = await start(cwd);
  await session.appendMessage(new HumanMessage("读取两个文件"));
  await session.appendMessage(requestReads("a", "b"));
  await session.appendMessage(result("a"));
  await session.appendMessage(result("b"));
  await session.appendCheckpoint("model", 1, 3);
  await session.appendMessage(new AIMessage("已完成"));
  await session.appendCheckpoint("input", 2, 3);

  const lines = (await readFile(session.filePath, "utf8")).trimEnd().split("\n");
  const records: SessionRecord[] = lines.map(line => JSON.parse(line));
  const index = records.findIndex(record => record.type === "checkpoint" && record.next === "model");
  const checkpoint = records[index];
  assert.ok(checkpoint.type === "checkpoint");
  checkpoint.afterEntryId = records[index - 2].id;
  [records[index - 1], records[index]] = [checkpoint, records[index - 1]];
  await writeFile(session.filePath, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  await assert.rejects(SessionManager.load(session.filePath, cwd), /工具结果还没有补齐/);
});

workspaceTest("中断后若检查点后已有工具调用，加载拒绝回退或重写文件", async cwd => {
  const session = await start(cwd);
  await session.appendMessage(new HumanMessage("执行工具"));
  await session.appendMessage(requestReads("a"));
  const before = await readFile(session.filePath);
  await assert.rejects(SessionManager.load(session.filePath, cwd), /检查点.*后还有记录/);
  assert.deepEqual(await readFile(session.filePath), before);
});

workspaceTest("检查点写入失败后，内存停止提供可恢复状态", async cwd => {
  const session = await start(cwd);
  await session.appendMessage(new HumanMessage("任务"));
  await session.appendMessage(new AIMessage("完成"));
  // 用目录占据文件路径，让追加稳定失败，不依赖用户权限。
  await rename(session.filePath, session.filePath + ".saved");
  await mkdir(session.filePath);
  await assert.rejects(session.appendCheckpoint("input", 1, 3), /保存会话失败/);
  assert.equal(session.checkpoint, undefined);
  assert.throws(() => session.getContextSnapshot(), /磁盘状态不确定/);
  assert.throws(() => session.getEntries(), /磁盘状态不确定/);
  await assert.rejects(session.appendMessage(new HumanMessage("再试")), /不能直接重试/);
});

workspaceTest("压缩切点必须前移到一条用户消息，拒绝后保留上次摘要", async cwd => {
  const session = await start(cwd);
  for (const question of ["第一问", "第二问", "第三问"]) {
    await session.appendMessage(new HumanMessage(question));
    await session.appendMessage(new AIMessage("回答"));
    await session.appendCheckpoint("input", 1, 3);
  }
  const recent = session.getContextSnapshot().recent;
  const entry = {
    type: "compaction" as const, id: crypto.randomUUID(), timestamp: new Date().toISOString(),
    summary: "第一问已完成", firstKeptEntryId: recent[2].id, tokensBefore: 200, tokensAfter: 120,
  };
  await session.appendCompaction(entry);
  await session.appendCheckpoint("input", 1, 3);
  const saved = await readFile(session.filePath, "utf8");
  for (const firstKeptEntryId of [recent[0].id, recent[2].id, recent[3].id, crypto.randomUUID()]) {
    await assert.rejects(session.appendCompaction({ ...entry, id: crypto.randomUUID(), firstKeptEntryId }), /压缩起点/);
  }
  assert.equal(await readFile(session.filePath, "utf8"), saved);
  const restored = await SessionManager.load(session.filePath, cwd);
  assert.equal(restored.getContextSnapshot().summary, entry.summary);
  assert.deepEqual(restored.getContextSnapshot().recent, recent.slice(2));
});
