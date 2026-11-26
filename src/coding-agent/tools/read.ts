import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../../agent/tools.ts";

export function createReadTool(credentialPaths: readonly string[]) {
  return defineTool({
    name: "read",
    description: "读取不超过 1 MB 的 UTF-8 文本文件。输出过长时截断。",
    schema: z.object({
      path: z.string().min(1).describe("相对工作目录的路径或绝对路径"),
    }),
    async execute({ path }, cwd, signal) {
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
        return await file.readFile({ encoding: "utf8", signal });
      } finally {
        await file.close();
      }
    },
  });
}
