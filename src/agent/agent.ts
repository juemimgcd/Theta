import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { runLoop } from "./agent-loop.ts";
import type { PrepareContext } from "./agent-loop.ts";
import type { AgentEndEvent, AgentEvent, EventListener, RunResult } from "./events.ts";
import { copyMessages } from "./hooks.ts";
import type { Hook } from "./hooks.ts";
import type { ModelIO, ReplyMode } from "../models/model-io.ts";
import type { Tool } from "./tools.ts";
import { responseCalls, validateHistory } from "./protocol.ts";

export type AgentOptions = {
  model: Pick<ModelIO, "request">;
  tools: readonly Tool[];
  systemPrompt: string;
  cwd: string;
  hooks?: readonly Hook[];
  maxTurns?: number;
};

export class Agent {
  private messages: BaseMessage[];
  private model: Pick<ModelIO, "request">;
  private tools: readonly Tool[];
  private hooks: readonly Hook[];
  private cwd: string;
  private maxTurns: number;
  private controller: AbortController | undefined;
  private listeners: Set<EventListener>;
  private deliveryFailed: boolean;

  constructor({ model, tools, systemPrompt, cwd, hooks = [], maxTurns = 8 }: AgentOptions) {

    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error("maxTurns 必须是正整数");
    }

    this.model = model;
    this.tools = [...tools];
    this.hooks = [...hooks];
    this.cwd = cwd;
    this.maxTurns = maxTurns;
    this.controller = undefined;
    this.listeners = new Set<EventListener>();
    this.deliveryFailed = false;
    this.messages = [new SystemMessage(systemPrompt)];
  }

  getMessages(): BaseMessage[] {
    return copyMessages(this.messages);
  }

  replaceMessages(messages: BaseMessage[]): void {
    if (this.controller !== undefined || this.deliveryFailed) {
      throw new Error("只能为未运行且未发生通知失败的 Agent 装入历史");
    }
    const restored = copyMessages(messages);
    if (!(restored[0] instanceof SystemMessage)) {
      throw new Error("会话必须以 SystemMessage 开始");
    }
    // 加载历史也是输入边界，复用同一个 protocol.ts，不另写配对规则。
    for (const message of restored) {
      if (message instanceof AIMessage) {
        responseCalls(message);
      }
    }
    validateHistory(restored);
    this.messages = restored;
  }


  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }


  private async emit(event: AgentEvent): Promise<void> {
    if (event.type === "message_end") {
      this.messages.push(event.message);
    }

    try {
      for (const listener of [...this.listeners]) {
        let notification: AgentEvent = { ...event };
        if (event.type === "message_end") {
          notification = {
            type: "message_end",
            message: copyMessages([event.message])[0],
          };
        }
        await listener(notification);
      }
    } catch (error: unknown) {
      this.deliveryFailed = true;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`事件通知失败：${detail}`, { cause: error });
    }
  }

  getTurnLimit(): number {
    return this.maxTurns;
  }

  prompt(input: string, prepareContext: PrepareContext, replyMode: ReplyMode = "stream"): Promise<RunResult> {
    return this.run(input, prepareContext, 0, this.maxTurns, replyMode);
  }

  resume(
    prepareContext: PrepareContext,
    completedTurns: number,
    maxTurns: number,
    replyMode: ReplyMode = "stream",
  ): Promise<RunResult> {
    return this.run(undefined, prepareContext, completedTurns, maxTurns, replyMode);
  }

  private async run(
    input: string | undefined,
    prepareContext: PrepareContext,
    completedTurns: number,
    maxTurns: number,
    replyMode: ReplyMode,
  ): Promise<RunResult> {
    if (this.controller !== undefined) {
      throw new Error("Agent 正在运行，请等待结束后再提交输入");
    }
    if (this.deliveryFailed) {
      throw new Error("之前的事件通知失败，状态可能未保存完整，请新建 Agent 后重试");
    }
    if (!Number.isInteger(completedTurns) || completedTurns < 0 ||
        !Number.isInteger(maxTurns) || maxTurns < 1 || completedTurns >= maxTurns) {
      throw new Error("恢复轮数无效或任务已经达到上限");
    }
    if (input !== undefined && input.trim() === "") {
      throw new Error("用户输入不能为空");
    }

    const controller = new AbortController();
    this.controller = controller;
    let ending: AgentEndEvent = {
      type: "agent_end",
      status: "error",
      detail: "本次运行未正常结束",
    };

    try {
      if (input !== undefined) {
        await this.emit({ type: "message_end", message: new HumanMessage(input) });
      }
      const result = await runLoop(
        prepareContext,
        this.model,
        this.tools,
        this.hooks,
        this.cwd,
        maxTurns,
        controller.signal,
        (event) => this.emit(event),
        completedTurns,
        replyMode,
      );
      ending = {
        type: "agent_end",
        status: result.status,
        detail: result.status === "completed" ? "已得到最终回答" : result.reason,
      };
      return result;
    } catch (error: unknown) {
      ending = {
        type: "agent_end",
        status: controller.signal.aborted ? "aborted" : "error",
        detail: error instanceof Error ? error.message : String(error),
      };
      throw error;
    } finally {
      try {
        if (!this.deliveryFailed) {
          await this.emit(ending);
        }
      } finally {
        this.controller = undefined;
      }
    }
  }

  abort(): void {
    this.controller?.abort();
  }
}
