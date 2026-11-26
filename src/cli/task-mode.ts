import type { Accounts } from "../coding-agent/accounts.ts";
import { createSession } from "../coding-agent/create-session.ts";
import { SessionManager } from "../coding-agent/session-manager.ts";
import { SessionConnection } from "../coding-agent/session-connection.ts";
import { isAccountCommand, type TaskCommand } from "./args.ts";
import { plainEvents } from "./plain-events.ts";
import { runLines } from "./line-mode.ts";
import { commandHelp, TerminalUI } from "./tui.ts";

export async function runTask(command: TaskCommand, accounts: Accounts, cwd: string, tty: boolean): Promise<void> {
  const { accountCommand, modelLabel } = accounts;
  const { latest, resume, task } = command;
  const file = latest ? await SessionManager.latestPath(cwd) : command.file;
  const print = plainEvents();
  let ui: TerminalUI | undefined;
  let active: AbortController | undefined;
  const log = (message: string) => ui ? ui.log(message) : console.error(message);
  const cancel = () => { active?.abort(); sessions.current?.abort(); };
  const interrupt = () => ui ? ui.interrupt() : cancel();
  const sessions = new SessionConnection(file, async path => {
    const opened = await createSession({
      accounts, cwd, filePath: path, log,
      beforeTool: (call, signal) => ui?.approve(call, signal),
    });
    opened.subscribe(event => ui ? ui.event(event) : print(event));
    return opened;
  });
  if (latest) await sessions.open();
  const resumeTask = resume && (!latest || sessions.current?.canResume);
  const singleRun = Boolean(task || resumeTask);
  if (tty && !singleRun) ui = new TerminalUI(cwd, modelLabel);

  async function submit(input?: string): Promise<void> {
    active = new AbortController();
    ui?.busy(input === "/compact" ? "正在压缩" : "等待模型", cancel);
    try {
      if (input === "/compact" && !sessions.current && !sessions.path) return log("[compact] 当前没有会话。");
      if (input === undefined && !sessions.current && !sessions.path) return log("当前没有可恢复的会话。");
      const opening = !sessions.current;
      const session = await sessions.open();
      if (opening) {
        if (ui) ui.setSession(session.filePath);
        else log(`[session] ${session.filePath}`);
      }
      active.signal.throwIfAborted();
      if (input === "/compact") {
        if (!await session.compact(active.signal)) log("[compact] 没有可压缩的早期任务或工具轮次。");
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
      const session = sessions.current;
      if (singleRun && session?.canResume) {
        log("用 theta --resume 可继续当前目录最近写入的会话。要指定本次任务，请使用 theta --resume <会话文件>。");
        log(`会话文件：${session.filePath}`);
      }
      if (singleRun && !active.signal.aborted) throw cause;
      log(active.signal.aborted ? "本次操作已取消。" : cause instanceof Error ? cause.message : String(cause));
      if (singleRun) process.exitCode = 130;
      if (singleRun || session?.acceptsInput) return;
      if (session?.canResume) return log("输入 /resume 继续原任务，或输入 /new 开启新会话。");
      if (session && input !== "/compact") {
        log(`会话已保存在 ${session.filePath}。下一条输入将开启新会话。`);
        sessions.startNew();
        ui?.setSession(undefined);
      }
    } finally {
      active = undefined;
    }
  }

  async function handleLine(input: string): Promise<void> {
    const [name, ...params] = input.slice(1).split(/\s+/);
    if (input === "/help") return log(commandHelp);
    if (input === "/resume") return submit();
    if (input === "/new") {
      sessions.startNew();
      ui?.setSession(undefined);
      return log("下一条任务将开启新会话。");
    }
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
      if (name === "model" || name === "logout" || name === "login") sessions.reconnect();
      active = undefined;
    }
  }

  process.on("SIGINT", interrupt);
  try {
    if (singleRun) {
      if (sessions.current) log(`[session] ${sessions.current.filePath}`);
      return await submit(resumeTask ? undefined : task);
    }
    if (ui) {
      ui.start();
      try {
        if (sessions.path) {
          const session = await sessions.open();
          ui.setSession(session.filePath);
          ui.restore(session.getHistoryMessages());
        } else {
          ui.say("输入任务开始对话。用 /login 登录，或用 /model 选择模型。");
        }
        for (;;) {
          const input = await ui.read();
          if (input === "/exit") break;
          await handleLine(input);
        }
      } finally { ui.stop(); }
    } else {
      if (sessions.path) await sessions.open();
      if (sessions.current) log(`[session] ${sessions.current.filePath}`);
      await runLines(handleLine, () => {
        if (!active) return false;
        cancel();
        return true;
      });
    }
  } finally { process.off("SIGINT", interrupt); }
}
