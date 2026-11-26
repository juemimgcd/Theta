import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../../agent/tools.ts";

export const editTool = defineTool({
  name: "edit",
  description: "Replace an exact passage in a small UTF-8 file. Read it first. oldText must be nonempty and occur exactly once.",
  schema: z.object({
    path: z.string().min(1).describe("Path to the existing file"),
    oldText: z.string().min(1).max(100_000).describe("Exact text to replace"),
    newText: z.string().max(100_000).describe("Replacement text. An empty string deletes the passage."),
  }),
  async execute(args, cwd, signal) {
    const fullPath = resolve(cwd, args.path);
    const info = await stat(fullPath);
    signal.throwIfAborted();

    if (!info.isFile() || info.size > 1_000_000) {
      throw new Error("edit 只处理不超过 1 MB 的普通文本文件");
    }

    const text = await readFile(fullPath, { encoding: "utf8", signal });
    signal.throwIfAborted();
    const first = text.indexOf(args.oldText);
    if (first === -1) {
      throw new Error("没有找到 oldText，请重新读取文件并提供精确文字");
    }
    if (text.indexOf(args.oldText, first + 1) !== -1) {
      throw new Error("oldText 出现不止一次，请提供更长且唯一的上下文");
    }

    const before = text.slice(0, first);
    const after = text.slice(first + args.oldText.length);
    const updated = before + args.newText + after;
    signal.throwIfAborted();
    await writeFile(fullPath, updated, "utf8");
    return `已在 ${args.path} 中替换 1 处文字`;
  },
});
