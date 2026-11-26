import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { Agent } from "../src/agent/agent.ts";
import { AgentSession } from "../src/coding-agent/agent-session.ts";
import { createBudget } from "../src/models/budget.ts";
import type { ModelIO } from "../src/models/model-io.ts";
import { SessionManager } from "../src/coding-agent/session-manager.ts";

const cwd = await mkdtemp(join(tmpdir(), "theta-session-"));
const budget = createBudget([]);
// 固定模型回复，让这个例子可以离线运行。
const model: ModelIO = {
  async request() { return new AIMessage("你好，小林。"); },
  async summarize() { return new AIMessage("用户叫小林。"); },
};

// 1. AgentSession.create 用 Agent 的初始消息创建会话文件，并订阅 Agent 的事件。
const options = { model, tools: [], cwd, systemPrompt: "根据对话历史，用中文回答用户。" };
const agent = new Agent(options);
const session = await AgentSession.create(agent, cwd, model, budget);
await session.prompt("我叫小林。");
console.log("Agent 内存里的消息数", agent.getMessages().length);

// 2. 从磁盘独立读一次，看看刚才的 prompt 让 SessionManager 保存了什么。
const saved = await SessionManager.load(session.filePath, cwd);
console.log("磁盘上的记录顺序", saved.getEntries().map(entry => entry.type).join(" → "));

// 3. 换一个全新的 Agent。load 把上一次的对话装进这个 Agent。
const nextAgent = new Agent(options);
console.log("加载前的消息数", nextAgent.getMessages().length);
await AgentSession.load(nextAgent, cwd, session.filePath, model, budget);
console.log("加载后的消息数", nextAgent.getMessages().length);
for (const message of nextAgent.getMessages().slice(1)) {
  console.log(message.type, message.text);
}
