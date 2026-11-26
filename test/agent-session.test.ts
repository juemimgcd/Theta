import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { Agent } from "../src/agent/agent.ts";
import { AgentSession } from "../src/coding-agent/agent-session.ts";
import { SessionManager } from "../src/coding-agent/session-manager.ts";
import { contextMessages } from "../src/coding-agent/context.ts";
import { writeTool } from "../src/coding-agent/tools/write.ts";
import { createBudget } from "../src/models/budget.ts";
import type { ModelIO } from "../src/models/model-io.ts";
import { workspaceTest } from "./workspace.ts";

const systemPrompt = "只处理当前工作目录";
const longReply = "已完成旧任务。".repeat(250);
const summary = "已完成旧任务，保留项目约束。";
const summaryModel: ModelIO["summarize"] = async () =>
  new AIMessage({ content: summary, response_metadata: { finish_reason: "stop" } });

workspaceTest("恢复等待模型的检查点时沿用原轮数，只消费已落盘的工具结果", async cwd => {
  const file = join(cwd, "note.txt");
  const model: ModelIO = {
    async request(messages) {
      if (messages.at(-1)?.type === "tool") throw new Error("模型连接中断");
      return new AIMessage({
        content: "", tool_calls: [{ id: "save", name: "write", args: { path: "note.txt", content: "第一次写入" } }],
      });
    },
    summarize: summaryModel,
  };
  const options = { tools: [writeTool], cwd, systemPrompt, model, maxTurns: 2 };
  const budget = createBudget(options.tools);
  const session = await AgentSession.create(new Agent(options), cwd, model, budget);
  await assert.rejects(session.prompt("写入文件"), /模型连接中断/);
  assert.equal(await readFile(file, "utf8"), "第一次写入");
  assert.equal(session.checkpoint.next, "model");
  assert.equal(session.checkpoint.turns, 1);
  await writeFile(file, "用户后来编辑的内容");

  const resumedModel: ModelIO = {
    async request(messages) {
      const toolResult = messages.at(-1);
      assert.ok(toolResult instanceof ToolMessage);
      assert.equal(toolResult.tool_call_id, "save");
      return new AIMessage("完成");
    },
    summarize: summaryModel,
  };
  const agent = new Agent({ ...options, model: resumedModel, maxTurns: 1 });
  const restored = await AgentSession.load(agent, cwd, session.filePath, resumedModel, budget);
  await assert.rejects(restored.prompt("新任务"), /已有任务等待恢复/);
  assert.deepEqual(await restored.resume(), { status: "completed", answer: "完成", turns: 2 });
  assert.equal(restored.checkpoint.maxTurns, 2);
  assert.equal(await readFile(file, "utf8"), "用户后来编辑的内容");
});

workspaceTest("自动压缩先落盘再请求模型，hook 修改请求不会污染会话快照", async cwd => {
  let file: string;
  let requests = 0;
  const model: ModelIO = {
    async request(messages) {
      requests++;
      if (requests === 1) return new AIMessage(longReply);
      assert.equal(messages.length, 3);
      assert.match(messages[1].text, new RegExp(summary));
      assert.equal(messages[2].text, "仅本轮可见");
      const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
      const last = JSON.parse(lines.at(-1)!);
      assert.equal(last.type, "compaction");
      assert.equal(last.summary, summary);
      return new AIMessage("完成新任务");
    },
    summarize: summaryModel,
  };
  const budget = createBudget([], undefined, { compactAt: 500 });
  const agent = new Agent({
    model, tools: [], cwd, systemPrompt,
    hooks: [{
      beforeModel(messages) {
        if (messages.at(-1)?.text === "新任务") {
          messages[0].additional_kwargs.hook = true;
          messages.at(-1)!.content = "仅本轮可见";
        }
      },
    }],
  });
  const session = await AgentSession.create(agent, cwd, model, budget, () => {});
  file = session.filePath;
  await session.prompt("旧任务");
  await session.prompt("新任务");
  assert.equal(requests, 2);
  const history = session.getHistoryMessages();
  assert.deepEqual(history.map(m => m.text), [systemPrompt, "旧任务", longReply, "新任务", "完成新任务"]);
  assert.equal(history[0].additional_kwargs.hook, undefined);

  const restored = await SessionManager.load(file, cwd);
  const before = restored.getEntries();
  const parts = restored.getContextSnapshot();
  assert.equal(parts.summary, summary);
  assert.deepEqual(parts.recent.map(entry => entry.message.data.content), ["新任务", "完成新任务"]);
  parts.system.data.additional_kwargs.changed = true;
  parts.recent[0].message.data.content = "修改快照";
  parts.recent.pop();
  const fullCopy = restored.getEntries();
  fullCopy.splice(0, fullCopy.length);
  assert.deepEqual(restored.getEntries(), before);
  assert.equal(restored.getContextSnapshot().recent.length, 2);
});

workspaceTest("手动压缩完成后重启，按摘要与近期原文继续对话", async cwd => {
  const budget = createBudget([]);
  const model: ModelIO = { request: async () => new AIMessage(longReply), summarize: summaryModel };
  const options = { model, tools: [], cwd, systemPrompt };
  const session = await AgentSession.create(new Agent(options), cwd, model, budget, () => {});
  const signal = new AbortController().signal;
  await session.prompt("第一问");
  assert.equal(await session.compact(signal), false);
  await session.prompt("第二问");
  const prior = session.checkpoint;
  assert.equal(await session.compact(signal), true);
  assert.equal(session.checkpoint.turns, prior.turns);
  assert.equal(session.checkpoint.maxTurns, prior.maxTurns);
  assert.ok(session.acceptsInput);

  const manager = await SessionManager.load(session.filePath, cwd);
  assert.deepEqual(manager.getEntries().slice(-2).map(e => e.type), ["compaction", "checkpoint"]);
  const expected = contextMessages(manager.getContextSnapshot());
  assert.deepEqual(expected.map(m => m.type), ["system", "human", "human", "ai"]);
  assert.match(expected[1].text, new RegExp(summary));
  assert.equal(expected[2].text, "第二问");

  let request: BaseMessage[] = [];
  const nextModel: ModelIO = {
    async request(messages) { request = messages; return new AIMessage("继续"); },
    summarize: summaryModel,
  };
  const nextAgent = new Agent({ ...options, model: nextModel });
  const next = await AgentSession.load(nextAgent, cwd, session.filePath, nextModel, budget);
  await next.prompt("第三问");
  assert.deepEqual(request.map(m => m.text), [...expected.map(m => m.text), "第三问"]);
});

workspaceTest("压缩记录写入失败时，本轮主模型请求不会发出", async cwd => {
  let requests = 0;
  let file: string;
  const model: ModelIO = {
    async request() { requests++; return new AIMessage(longReply); },
    async summarize(messages, signal) {
      await rename(file, file + ".saved");
      await mkdir(file);
      return summaryModel(messages, signal);
    },
  };
  const agent = new Agent({ model, tools: [], cwd, systemPrompt });
  const budget = createBudget([], undefined, { compactAt: 500 });
  const session = await AgentSession.create(agent, cwd, model, budget, () => {});
  file = session.filePath;
  await session.prompt("旧任务");
  await assert.rejects(session.prompt("新任务"), /保存会话失败/);
  assert.equal(requests, 1);
  assert.equal(session.acceptsInput, false);
});

workspaceTest("取消一批工具调用时，每个调用都有结果，恢复后可接收新输入", async cwd => {
  const ids = ["first", "second"];
  const model: ModelIO = {
    async request() {
      return new AIMessage({
        content: "", tool_calls: ids.map(id => ({ id, name: "write", args: { path: id, content: id } })),
      });
    },
    summarize: summaryModel,
  };
  const agent = new Agent({ model, tools: [writeTool], cwd, systemPrompt });
  const session = await AgentSession.create(agent, cwd, model, createBudget([writeTool]));
  session.subscribe(event => {
    if (event.type === "tool_start" && event.callId === "first") session.abort();
  });
  await assert.rejects(session.prompt("写入两个文件"), { name: "AbortError" });
  const restored = await SessionManager.load(session.filePath, cwd);
  const results = restored.getHistoryMessages().filter(m => m instanceof ToolMessage);
  assert.deepEqual(results.map(m => [m.tool_call_id, m.status]), [["first", "error"], ["second", "error"]]);
  assert.equal(restored.checkpoint?.next, "input");
  assert.equal(restored.checkpoint.turns, 1);
  for (const id of ids) await assert.rejects(readFile(join(cwd, id)), { code: "ENOENT" });
});
