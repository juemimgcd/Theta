import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { prepareRequestContext } from "../src/coding-agent/compact.ts";
import { contextMessages, type ContextParts } from "../src/coding-agent/context.ts";
import { encodeMessage } from "../src/coding-agent/message-codec.ts";
import { createBudget, estimateMessages } from "../src/models/budget.ts";

const system = encodeMessage(new SystemMessage("系统规则"));
if (system.type !== "system") throw new Error("样本首条消息应为系统消息");
const parts: ContextParts = {
  system, summary: "已有摘要",
  recent: [new HumanMessage("旧任务"), new AIMessage("旧结果".repeat(300)), new HumanMessage("保留当前任务")].map(message => ({
    type: "message", id: crypto.randomUUID(), timestamp: new Date().toISOString(), message: encodeMessage(message),
  })),
};
const budget = createBudget([]);
const signal = new AbortController().signal;

test("低于阈值时，模型收到现有摘要和全部近期原文", async () => {
  const model = { async summarize(): Promise<AIMessage> { throw new Error("意外调用摘要"); } };
  const logs: string[] = [];
  const prepared = await prepareRequestContext(parts, model, budget, signal, "budget", text => logs.push(text));
  assert.equal(prepared.compaction, undefined);
  assert.deepEqual(logs, []);
  assert.deepEqual(prepared.messages.map(m => m.toDict()), contextMessages(parts).map(m => m.toDict()));
});

test("达到阈值时合并旧摘要，保留最近任务并记录实际的前后预算", async () => {
  const before = estimateMessages(contextMessages(parts));
  const result = await prepareRequestContext(parts, {
    async summarize(input) {
      const payload = JSON.parse(input[1].text);
      assert.equal(payload.previousSummary, "已有摘要");
      assert.deepEqual(payload.history, parts.recent.slice(0, 2).map(entry => entry.message));
      return new AIMessage({ content: "合并后的摘要", response_metadata: { finish_reason: "stop" } });
    },
  }, { ...budget, compactAt: before }, signal);
  assert.ok(result.compaction);
  assert.equal(result.compaction.firstKeptEntryId, parts.recent[2].id);
  assert.equal(result.compaction.tokensBefore, before);
  assert.equal(result.compaction.tokensAfter, estimateMessages(result.messages));
  assert.ok(result.compaction.tokensAfter < before);
  assert.equal(result.messages.length, 3);
  assert.match(result.messages[1].text, /合并后的摘要/);
  assert.equal(result.messages[2].text, "保留当前任务");
});

test("摘要失败时仅在原上下文仍符合预算的自动压缩中继续", async () => {
  const error = new Error("摘要服务不可用");
  const model = { async summarize(): Promise<AIMessage> { throw error; } };
  const settings = { ...budget, compactAt: 1 };
  const logs: string[] = [];
  const result = await prepareRequestContext(parts, model, settings, signal, "budget", line => logs.push(line));
  assert.equal(result.compaction, undefined);
  assert.deepEqual(result.messages.map(m => m.text), contextMessages(parts).map(m => m.text));
  assert.match(logs.join("\n"), /摘要服务不可用/);
  await assert.rejects(prepareRequestContext(parts, model, settings, signal, "manual"), cause => cause === error);
  await assert.rejects(prepareRequestContext(parts, model, { ...settings, messageLimit: 1 }, signal), cause => cause === error);
});
