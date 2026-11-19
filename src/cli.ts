#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { accountCommands, createAccounts, type Accounts } from "./accounts.ts";
import { createSession } from "./app.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentEvent } from "./events.ts";
import { SessionManager } from "./session-manager.ts";
import { commandHelp, TerminalUI } from "./tui.ts";

const usage = [
  'theta ["新任务"]',
  'theta --session <会话文件> ["新问题"]',
  'theta --resume [会话文件]',
  'theta login [服务商 [api_key|oauth]]',
  'theta logout [服务商]',
  'theta model [服务商/模型ID|env]',
  'theta providers | status',
  '全局选项：在命令前加 --theta-home <账号目录>。',
  '交互命令包括 /login、/model、/status、/compact 和 /help。',
].join("\n");

function isAccountCommand(name: string): boolean {
  return accountCommands.some(command => command === name);
}

function plainEvents(): (event: AgentEvent) => void {
  let lineOpen = false;
  return event => {
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
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let directory: string | undefined;
  if (args[0] === "--theta-home") {
    const path = args[1];
    if (!path || path.startsWith("--")) throw new Error("--theta-home 需要指定账号目录。");
    directory = resolve(path);
    args.splice(0, 2);
  }
  if (args[0] === "--help" || args[0] === "-h") return console.log(usage);
  const accounts = createAccounts(directory);
  try {
    await run(args, accounts);
  } finally {
    await accounts.settleAccountWrites();
  }
}

async function run(args: string[], accounts: Accounts): Promise<void> {
  const { accountCommand, modelLabel } = accounts;
  const cwd = process.cwd();
  const tty = process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== "dumb";
  const command = args[0];
  if (command && isAccountCommand(command)) {
    const needsPrompt = command === "login" || (command === "logout" && !args[1]) ||
      (command === "model" && args[1] !== "env" && !args[1]?.includes("/"));
    if (!tty || !needsPrompt) return console.log(await accountCommand(command, args.slice(1)));
    const ui = new TerminalUI(cwd, modelLabel);
    const active = new AbortController();
    const cancel = () => active.abort();
    process.on("SIGINT", cancel);
    let result: string;
    ui.start();
    try {
      ui.busy("账号配置", cancel);
      result = await accountCommand(command, args.slice(1), ui.interaction(active.signal));
    } catch (cause) {
      if (!active.signal.aborted) throw cause;
      result = "已取消。";
      process.exitCode = 130;
    } finally {
      ui.stop();
      process.off("SIGINT", cancel);
    }
    return console.log(result);
  }

  const resume = command === "--resume";
  const latest = resume && args.length === 1;
  let file: string | undefined;
  if (resume || command === "--session") {
    args.shift();
    file = latest ? await SessionManager.latestPath(cwd) : args.shift();
    if (!file || file.startsWith("--")) throw new Error("请指定会话文件。\n" + usage);
    if (resume && args.length) throw new Error("--resume 从检查点继续原任务，不能同时提交新问题。");
  } else if (command?.startsWith("--")) throw new Error(usage);

  const task = args.join(" ").trim();
  const print = plainEvents();
  let ui: TerminalUI | undefined;
  let session: AgentSession | undefined;
  let active: AbortController | undefined;
  const log = (message: string) => ui ? ui.log(message) : console.error(message);
  const cancel = () => { active?.abort(); session?.abort(); };
  const interrupt = () => ui ? ui.interrupt() : cancel();
  async function open(): Promise<AgentSession> {
    const opened = await createSession(accounts, cwd, file, { log, beforeTool: (call, signal) => ui?.approve(call, signal) });
    opened.subscribe(event => ui ? ui.event(event) : print(event));
    return opened;
  }
  if (latest) session = await open();
  const resumeTask = resume && (!latest || session?.checkpoint.next === "model");
  const singleRun = Boolean(task || resumeTask);
  if (tty && !singleRun) ui = new TerminalUI(cwd, modelLabel);

  async function submit(input?: string): Promise<void> {
    active = new AbortController();
    ui?.busy(input === "/compact" ? "正在压缩" : "等待模型", cancel);
    try {
      if (input === "/compact" && !session && !file) return log("[compact] 当前没有会话。");
      if (!session) {
        session = await open();
        if (ui) ui.setSession(session.filePath);
        else log(`[session] ${session.filePath}`);
      }
      active.signal.throwIfAborted();
      if (input === "/compact") {
        if (!await session.compact(active.signal)) log("[compact] 没有可压缩的完整旧任务。");
        return;
      }
      const mode = singleRun ? "complete" : "stream";
      const result = input === undefined ? await session.resume(mode) : await session.prompt(input, mode);
      if (result.status === "completed") {
        if (singleRun) console.log(result.answer);
      } else {
        log(result.reason);
        if (singleRun) process.exitCode = 2;
      }
    } catch (cause) {
      if (singleRun && !active.signal.aborted) throw cause;
      log(active.signal.aborted ? "本次操作已取消。" : cause instanceof Error ? cause.message : String(cause));
      if (singleRun) process.exitCode = 130;
      if (active.signal.aborted && session?.acceptsInput) return;
      if (session && input !== "/compact") {
        log(`会话已保存在 ${session.filePath}。下一条输入将开启新会话。`);
        session = undefined;
        file = undefined;
        ui?.setSession(undefined);
      }
    } finally {
      active = undefined;
    }
  }

  async function handleLine(input: string): Promise<void> {
    const [name, ...params] = input.slice(1).split(/\s+/);
    if (input === "/help") return log(commandHelp);
    if (!input.startsWith("/") || !isAccountCommand(name)) return submit(input);
    active = new AbortController();
    ui?.busy("账号配置", cancel);
    try {
      const message = await accountCommand(name, params, ui?.interaction(active.signal));
      log(name === "status" && ui ? message + "\n" + ui.status() : message);
    } catch (cause) {
      log(active.signal.aborted ? "已取消。" : cause instanceof Error ? cause.message : String(cause));
    } finally {
      // Reopen the same history with the current account, including after a partially completed login.
      if (session && (name === "model" || name === "logout" || name === "login")) {
        file = session.filePath;
        session = undefined;
      }
      active = undefined;
    }
  }

  process.on("SIGINT", interrupt);
  try {
    if (singleRun) {
      if (session) log(`[session] ${session.filePath}`);
      return await submit(resumeTask ? undefined : task);
    }
    if (ui) {
      ui.start();
      try {
        if (file) {
          session ??= await open();
          ui.setSession(session.filePath);
          ui.restore(session.getMessages());
        } else {
          ui.say("输入任务开始对话。首次使用可输入 /login 登录，或用 /model 选择已配置的模型。");
        }
        for (;;) {
          const input = await ui.read();
          if (input === "/exit") break;
          await handleLine(input);
        }
      } finally { ui.stop(); }
    } else {
      if (file && !session) session = await open();
      if (session) log(`[session] ${session.filePath}`);
      const terminal = Boolean(process.stdin.isTTY && process.stderr.isTTY);
      const lines = createInterface({ input: process.stdin, output: process.stderr, terminal, prompt: "> " });
      lines.on("SIGINT", () => active ? cancel() : lines.close());
      try {
        if (terminal) lines.prompt();
        for await (const line of lines) {
          const input = line.trim();
          if (input === "/exit") break;
          if (input) await handleLine(input);
          if (terminal) lines.prompt();
        }
      } finally { lines.close(); }
    }
  } finally { process.off("SIGINT", interrupt); }
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
