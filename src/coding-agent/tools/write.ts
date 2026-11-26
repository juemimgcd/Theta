import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../../agent/tools.ts";

export const writeTool = defineTool({
  name: "write",
  description: "Create or overwrite a UTF-8 text file, creating parent directories as needed. Use edit for partial changes.",
  schema: z.object({
    path: z.string().min(1).describe("Path to the target file"),
    content: z.string().max(100_000).describe("Full file contents, up to 100,000 UTF-16 code units"),
  }),
  async execute(args, cwd, signal) {
    const fullPath = resolve(cwd, args.path);
    await mkdir(dirname(fullPath), { recursive: true });
    signal.throwIfAborted();

    // Once the write starts, wait for its actual outcome before acknowledging cancellation.
    await writeFile(fullPath, args.content, "utf8");
    return `已写入 ${args.path}，内容长度为 ${args.content.length} 个 UTF-16 代码单元`;
  },
});
