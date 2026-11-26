import type { BaseMessage } from "@langchain/core/messages";
import type { Budget } from "../models/budget.ts";
import { prepareRequestContext } from "./compact.ts";
import type { ModelIO, ReplyMode } from "../models/model-io.ts";
import type { Agent } from "../agent/agent.ts";
import type { EventListener, RunResult } from "../agent/events.ts";
import type { CheckpointEntry } from "./session-types.ts";
import type { RunPosition } from "./checkpoint.ts";
import { SessionManager } from "./session-manager.ts";

export class AgentSession {
  private agent: Agent;
  private manager: SessionManager;
  private model: ModelIO;
  private budget: Budget;
  private busy = false;
  private log: (message: string) => void;

  private constructor(agent: Agent, manager: SessionManager, model: ModelIO, budget: Budget, log: (message: string) => void) {
    this.log = log;
    this.agent = agent;
    this.manager = manager;
    this.model = model;
    this.budget = budget;
    this.agent.subscribe(async (event) => {
      if (event.type === "message_end") {
        await this.manager.appendMessage(event.message);
      } else if (event.type === "run_boundary") {
        await this.manager.appendCheckpoint(event.next, event.turns, event.maxTurns);
      }
    });
  }

  static async create(agent: Agent, cwd: string, model: ModelIO, budget: Budget, log: (message: string) => void = console.error): Promise<AgentSession> {
    const manager = await SessionManager.create(cwd, agent.getMessages());
    await manager.appendCheckpoint("input", 0, agent.getTurnLimit());
    return new AgentSession(agent, manager, model, budget, log);
  }

  static async load(agent: Agent, cwd: string, filePath: string, model: ModelIO, budget: Budget, log: (message: string) => void = console.error): Promise<AgentSession> {
    const manager = await SessionManager.load(filePath, cwd);
    try {
      agent.replaceMessages(manager.getHistoryMessages());
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法继续会话 ${manager.filePath}：${detail}。不会重放工具或删除记录`, {
        cause: error,
      });
    }
    return new AgentSession(agent, manager, model, budget, log);
  }

  get filePath(): string {
    return this.manager.filePath;
  }

  get id(): string {
    return this.manager.id;
  }

  getHistoryMessages(): BaseMessage[] {
    return this.manager.getHistoryMessages();
  }

  get checkpoint(): CheckpointEntry {
    const checkpoint = this.manager.checkpoint;
    if (!checkpoint) throw new Error(`会话没有可用的末尾检查点：${this.filePath}`);
    return checkpoint;
  }

  get acceptsInput(): boolean {
    return this.manager.position?.next === "input";
  }

  get canResume(): boolean {
    return this.manager.position?.next === "model";
  }

  private async atBoundary<T>(work: (position: RunPosition) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("会话正在运行或压缩，请等待当前操作结束。");
    this.busy = true;
    try {
      const position = this.manager.position;
      if (!position) throw new Error(`会话没有可用的恢复位置：${this.filePath}`);
      return await work(position);
    } finally {
      this.busy = false;
    }
  }

  compact(signal: AbortSignal): Promise<boolean> {
    return this.atBoundary(async checkpoint => {
      if (checkpoint.next !== "input") throw new Error("请先从检查点恢复任务，再压缩历史。");
      const { compaction: entry } = await prepareRequestContext(
        this.manager.getContextSnapshot(), this.model, this.budget, signal, "manual", this.log,
      );
      if (!entry) return false;
      await this.manager.appendCompaction(entry);
      await this.manager.appendCheckpoint("input", checkpoint.turns, checkpoint.maxTurns);
      this.log(`[compact] 估算 ${entry.tokensBefore} → ${entry.tokensAfter} tokens`);
      return true;
    });
  }

  private async prepareContext(signal: AbortSignal): Promise<BaseMessage[]> {
    const { messages, compaction: entry } = await prepareRequestContext(
      this.manager.getContextSnapshot(), this.model, this.budget, signal, "budget", this.log,
    );
    signal.throwIfAborted();
    if (entry !== undefined) {
      // 保存错误不能当作摘要失败忽略。写失败后 Manager 会拒绝继续追加。
      await this.manager.appendCompaction(entry);
      this.log(`[compact] 估算 ${entry.tokensBefore} → ${entry.tokensAfter}`);
    }
    return messages;
  }

  prompt(input: string, replyMode: ReplyMode = "stream"): Promise<RunResult> {
    return this.atBoundary(async checkpoint => {
      if (checkpoint.next !== "input") throw new Error("已有任务等待恢复，请使用 --resume。");
      return this.agent.prompt(input, signal => this.prepareContext(signal), replyMode);
    });
  }

  resume(replyMode: ReplyMode = "stream"): Promise<RunResult> {
    return this.atBoundary(async checkpoint => {
      if (checkpoint.next !== "model") throw new Error("会话正在等待新输入，请使用 --session <路径> <新问题>。");
      return this.agent.resume(signal => this.prepareContext(signal), checkpoint.turns, checkpoint.maxTurns, replyMode);
    });
  }

  abort(): void {
    this.agent.abort();
  }

  subscribe(listener: EventListener): () => void {
    return this.agent.subscribe(listener);
  }
}
