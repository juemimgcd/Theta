import { createInterface } from "node:readline";

export async function runLines(handleLine: (input: string) => Promise<void>, cancelActive: () => boolean): Promise<void> {
  const terminal = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const lines = createInterface({ input: process.stdin, output: process.stderr, terminal, prompt: "> " });
  lines.on("SIGINT", () => { if (!cancelActive()) lines.close(); });
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
