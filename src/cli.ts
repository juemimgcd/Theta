#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { createSession } from "./app.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentEvent } from "./events.ts";
import { SessionManager } from "./session-manager.ts";

const usage = [
  'theta ["新任务"]',
  'theta --session <会话文件> ["新问题"]',
  'theta --resume [会话文件]',
  "交互命令：/compact、/exit。Ctrl+C 取消运行。",
].join("\n");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(usage);
    return;
  }
  const cwd = process.cwd();
  const resume = args[0] === "--resume";
  const latest = resume && args.length === 1;
  let file: string | undefined;
  if (resume || args[0] === "--session") {
    args.shift();
    file = latest ? await SessionManager.latestPath(cwd) : args.shift();
    if (!file || file.startsWith("--")) throw new Error("请指定会话文件。\n" + usage);
    if (resume && args.length) throw new Error("--resume 从检查点继续原任务，不能同时提交新问题。");
  } else if (args[0]?.startsWith("--")) {
    throw new Error(usage);
  }
  let session: AgentSession | undefined;
  let lineOpen = false;
  function print(event: AgentEvent): void {
    if (event.type === "text_delta") {
      process.stdout.write(event.text);
      lineOpen = !event.text.endsWith("\n");
      return;
    }
    if (lineOpen) process.stdout.write("\n");
    lineOpen = false;
    switch (event.type) {
      case "message_end": console.error(`[message_end] ${event.message.type}`); break;
      case "tool_start": console.error(`[tool_start] ${event.name} ${event.callId}`); break;
      case "tool_end": console.error(`[tool_end] ${event.name} ${event.status}`); break;
      case "turn_end": console.error(`[turn_end] 第 ${event.turn} 轮，${event.toolCount} 次调用`); break;
      case "run_boundary": console.error(`[checkpoint] ${event.next} ${event.turns}/${event.maxTurns}`); break;
      case "agent_end": console.error(`[agent_end] ${event.status}`); break;
    }
  }
  async function open(path?: string): Promise<AgentSession> {
    const opened = await createSession(cwd, path);
    opened.subscribe(print);
    console.error(`[session] ${opened.filePath}`);
    return opened;
  }
  if (file) session = await open(file);

  const task = args.join(" ").trim();
  const resumeTask = resume && (!latest || session?.checkpoint.next === "model");
  const singleRun = Boolean(task || resumeTask);
  let active: AbortController | undefined;
  const cancel = () => {
    active?.abort();
    session?.abort();
  };
  async function submit(input?: string): Promise<void> {
    active = new AbortController();
    try {
      session ??= await open();
      active.signal.throwIfAborted();
      if (input === "/compact") {
        if (!await session.compact(active.signal)) console.error("[compact] 没有可压缩的完整旧任务。");
        return;
      }
      const replyMode = singleRun ? "complete" : "stream";
      const result = input === undefined ? await session.resume(replyMode) : await session.prompt(input, replyMode);
      if (result.status === "completed") {
        if (singleRun) console.log(result.answer);
      } else {
        console.error(result.reason);
        if (singleRun) process.exitCode = 2;
      }
    } catch (cause) {
      if (!active.signal.aborted) throw cause;
      console.error("[取消] 本次运行已停止。", cause instanceof Error ? cause.message : String(cause));
      if (singleRun) process.exitCode = 130;
      else console.error("下一条输入将开启新会话。");
      session = undefined;
    } finally {
      active = undefined;
    }
  }
  process.on("SIGINT", cancel);
  try {
    if (singleRun) return await submit(resumeTask ? undefined : task);
    const terminal = Boolean(process.stdin.isTTY && process.stderr.isTTY);
    const lines = createInterface({ input: process.stdin, output: process.stderr, terminal, prompt: "> " });
    lines.on("SIGINT", () => active ? cancel() : lines.close());
    try {
      if (terminal) lines.prompt();
      for await (const line of lines) {
        const input = line.trim();
        if (input === "/exit") break;
        if (input === "/compact" && !session) console.error("[compact] 当前没有会话。");
        else if (input) {
          try {
            await submit(input);
          } catch (cause) {
            console.error(cause instanceof Error ? cause.message : String(cause));
            if (session && input !== "/compact") {
              console.error(`会话已保存在 ${session.filePath}。下一条输入将开启新会话。`);
              session = undefined;
            }
          }
        }
        if (terminal) lines.prompt();
      }
    } finally {
      lines.close();
    }
  } finally {
    process.off("SIGINT", cancel);
  }
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
