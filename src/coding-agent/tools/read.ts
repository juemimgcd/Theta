import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../../agent/tools.ts";
import { TOOL_RESULT_LIMIT } from "../coding-policy.ts";

export function createReadTool(credentialPaths: readonly string[]) {
  return defineTool({
    name: "read",
    description: "按行读取不超过 1 MB 的 UTF-8 文本文件。offset 从 1 开始，limit 为行数；按结果中的 offset 继续读取。",
    schema: z.object({
      path: z.string().min(1).describe("相对工作目录的路径或绝对路径"),
      offset: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
    }),
    async execute({ path, offset = 1, limit }, cwd, signal) {
      const file = await open(resolve(cwd, path), constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const info = await file.stat({ bigint: true });
        if (!info.isFile()) throw new Error("read 只能读取普通文件");
        if (info.size > 1_000_000n) throw new Error("read 只读取不超过 1 MB 的文本文件");

        // Check the open file so symlinks and hard links cannot make credentials readable.
        for (const credentialPath of credentialPaths) {
          const credential = await stat(credentialPath, { bigint: true, throwIfNoEntry: false });
          if (credential?.dev === info.dev && credential.ino === info.ino) {
            throw new Error("read 无法读取 Theta 的登录凭据");
          }
        }
        signal.throwIfAborted();
        const text = await file.readFile({ encoding: "utf8", signal });
        if (offset === 1 && limit === undefined && text.length <= TOOL_RESULT_LIMIT) return text;

        const lines = text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        if (!lines.length && offset === 1) return "";
        if (offset > lines.length) throw new Error(`offset=${offset} 超出文件范围（共 ${lines.length} 行）`);

        // Reserve room for the range and continuation even after the coding policy limits tool output.
        const start = offset - 1;
        const end = Math.min(lines.length, start + (limit ?? lines.length));
        const pageLimit = TOOL_RESULT_LIMIT - 160;
        let body = "";
        let index = start;
        let clipped = false;
        while (index < end) {
          const line = lines[index];
          if (index > start && body.length + 1 + line.length > pageLimit) break;
          clipped = line.length > pageLimit;
          body += (index === start ? "" : "\n") + line.slice(0, pageLimit);
          index++;
        }
        const next = index < lines.length ? `；继续读取 offset=${index + 1}` : "";
        const note = clipped ? "；该行过长，仅显示开头" : "";
        return `${body}\n[第 ${offset}–${index} 行，共 ${lines.length} 行${note}${next}]`;
      } finally {
        await file.close();
      }
    },
  });
}
