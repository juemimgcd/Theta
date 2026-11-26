import { resolve } from "node:path";
import { accountCommands } from "../coding-agent/accounts.ts";

export const usage = [
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

export function isAccountCommand(name: string): boolean {
  return accountCommands.some(command => command === name);
}

type Command =
  | { kind: "help" }
  | { kind: "account"; name: string; args: string[] }
  | { kind: "task"; resume: boolean; latest: boolean; file?: string; task: string };

export function parseArgs(argv: string[]): { directory?: string; command: Command } {
  const args = [...argv];
  let directory: string | undefined;
  if (args[0] === "--theta-home") {
    const path = args[1];
    if (!path || path.startsWith("--")) throw new Error("--theta-home 需要指定账号目录。");
    directory = resolve(path);
    args.splice(0, 2);
  }
  const name = args[0];
  if (name === "--help" || name === "-h") return { directory, command: { kind: "help" } };
  if (name && isAccountCommand(name)) return { directory, command: { kind: "account", name, args: args.slice(1) } };
  const resume = name === "--resume";
  const latest = resume && args.length === 1;
  let file: string | undefined;
  if (resume || name === "--session") {
    args.shift();
    if (!latest) {
      file = args.shift();
      if (!file || file.startsWith("--")) throw new Error("请指定会话文件。\n" + usage);
    }
    if (resume && args.length) throw new Error("--resume 从检查点继续原任务，不能同时提交新问题。");
  } else if (name?.startsWith("--")) throw new Error(usage);
  return { directory, command: { kind: "task", resume, latest, file, task: args.join(" ").trim() } };
}

export type TaskCommand = Extract<Command, { kind: "task" }>;
