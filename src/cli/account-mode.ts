import type { Accounts } from "../coding-agent/accounts.ts";
import { TerminalUI } from "./tui.ts";

export async function runAccount(command: string, args: string[], accounts: Accounts, cwd: string, tty: boolean): Promise<void> {
  const { accountCommand, modelLabel } = accounts;
  const needsPrompt = command === "login" || (command === "logout" && !args[0]) ||
    (command === "model" && args[0] !== "env" && !args[0]?.includes("/"));
  if (!tty || !needsPrompt) return console.log(await accountCommand(command, args));
  const ui = new TerminalUI(cwd, modelLabel);
  const active = new AbortController();
  const cancel = () => active.abort();
  process.on("SIGINT", cancel);
  let result: string;
  ui.start();
  try {
    ui.busy("账号配置", cancel);
    result = await accountCommand(command, args, ui.interaction(active.signal));
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
