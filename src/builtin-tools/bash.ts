import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { defineTool, truncateOutput } from "../tools.ts";

export const bashTool = defineTool({
  name: "bash",
  description: "在工作目录执行短时非交互 bash 命令，返回输出和退出状态。不要启动后台服务。",
  schema: z.object({
    command: z.string().min(1).max(10_000),
    timeoutMs: z.number().int().min(1).max(60_000).optional().describe("默认 10000 毫秒"),
  }),
  async execute({ command, timeoutMs = 10_000 }, cwd, signal) {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const groupId = child.pid;
    const stop = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let stopped: string | undefined;
    const terminate = (reason: string) => {
      if (stopped !== undefined) return;
      stopped = reason;
      // shell 和前台管道属于同一个进程组，只终止 shell 会留下仍在工作的子进程。
      if (groupId !== undefined && groupId > 0) {
        try {
          process.kill(-groupId, "SIGKILL");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") stopped += `；终止进程组时：${String(cause)}`;
        }
      }
      // 后代可能仍持有输出管道，终止后只返回已经捕获的前缀。
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const cancel = () => terminate(signal.aborted ? "已取消" : `超过 ${timeoutMs} 毫秒`);
    stop.addEventListener("abort", cancel, { once: true });
    try {
      const stdout = captureOutput(child.stdout, "stdout", terminate);
      const stderr = captureOutput(child.stderr, "stderr", terminate);
      const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => done({ code, signal }));
      });
      const output = `stdout:\n${stdout()}\nstderr:\n${stderr()}`;
      if (status.code !== 0 || stopped !== undefined) {
        throw new Error(`${stopped ?? "命令失败"}，code=${status.code}，signal=${status.signal}\n${output}`);
      }
      return `命令退出码：0\n${output}`;
    } finally {
      stop.removeEventListener("abort", cancel);
    }
  },
});

function captureOutput(stream: Readable, name: string, terminate: (reason: string) => void): () => string {
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let output = "";
  // 按原始字节判断超限，展示用的文本前缀单独按字符截取。
  stream.once("error", error => terminate(`${name} 读取失败：${error.message}`));
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (output.length < 5001) output += decoder.write(chunk).slice(0, 5001 - output.length);
    if (bytes > 1_000_000) terminate(`${name} 超过 1,000,000 字节`);
  });
  return () => truncateOutput(output + decoder.end(), 5000);
}
