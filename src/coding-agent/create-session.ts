import { readRunSettings } from "./run-settings.ts";
import { createCodingPolicy } from "./coding-policy.ts";
import type { Accounts } from "./accounts.ts";
import { createCatalogIO } from "../models/catalog-model.ts";
import { createBudget, withBudget } from "../models/budget.ts";
import { Agent } from "../agent/agent.ts";
import { AgentSession } from "./agent-session.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { bashTool } from "./tools/bash.ts";
import { editTool } from "./tools/edit.ts";
import { createReadTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import type { Hook } from "../agent/hooks.ts";
import { createOpenAIModel } from "../models/openai-model.ts";
import type { Tool } from "../agent/tools.ts";

type SessionOptions = {
  accounts: Accounts;
  cwd: string;
  filePath?: string;
  log?: (message: string) => void;
  beforeTool?: Hook["beforeTool"];
};

export async function createSession({
  accounts, cwd, filePath, log = console.error, beforeTool,
}: SessionOptions): Promise<AgentSession> {
  const config = await accounts.connection();

  const tools: Tool[] = [createReadTool(accounts.credentialPaths), writeTool, editTool, bashTool];
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`工具名称重复：${tool.name}`);
    }
    names.add(tool.name);
  }

  const settings = readRunSettings(process.env);
  const hooks = [createCodingPolicy(settings, log)];
  const budget = createBudget(tools, config.type === "catalog" ? config.model : undefined, settings);
  if (beforeTool) hooks.push({ beforeTool });
  const transport = config.type === "catalog" ? createCatalogIO(config, tools, budget)
    : createOpenAIModel(config.model, config.apiKey, tools, budget, config.baseURL);
  const model = withBudget(transport, budget, settings.debugContext, log);
  const agent = new Agent({ model, tools, cwd, hooks, systemPrompt: buildSystemPrompt(tools) });
  if (filePath !== undefined) {
    return await AgentSession.load(agent, cwd, filePath, model, budget, log);
  }
  return await AgentSession.create(agent, cwd, model, budget, log);
}
