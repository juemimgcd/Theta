import { createAccounts } from "../coding-agent/accounts.ts";
import { parseArgs, usage } from "./args.ts";
import { runAccount } from "./account-mode.ts";
import { runTask } from "./task-mode.ts";

export async function main(argv: string[]): Promise<void> {
  const { directory, command } = parseArgs(argv);
  if (command.kind === "help") return console.log(usage);
  const accounts = createAccounts(directory);
  const cwd = process.cwd();
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== "dumb");
  try {
    if (command.kind === "account") return await runAccount(command.name, command.args, accounts, cwd, tty);
    await runTask(command, accounts, cwd, tty);
  } finally {
    await accounts.settleAccountWrites();
  }
}
