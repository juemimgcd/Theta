import type { Tool } from "../agent/tools.ts";

const replyLanguageInstruction =
  "Use any language the user explicitly requested for this reply. Otherwise, reply in the language of their latest request, " +
  "even when quoted text, code, tool results, or earlier conversation use another language.";

function englishBasePrompt(toolDescription: string): string {
  return [
    "You are Theta, a coding agent working in a local terminal.",
    toolDescription,
    "Read files before relying on their contents. Check the original text before editing, then verify changes by reading the file or running a suitable command.",
    "Only take actions needed for the user's task. Run short, non-interactive commands and do not start background services.",
    "If a policy denies a tool call, respect the restriction and explain what you could not complete.",
    "In your final reply, distinguish completed work from anything still unverified.",
  ].join("\n");
}

export function buildSystemPrompt(tools: readonly Tool[]): string {
  const names = tools.map(tool => tool.name);
  const available = names.length ? `Available tools: ${names.join(", ")}.` : "No tools are available.";
  return `${englishBasePrompt(available)}\n${replyLanguageInstruction}`;
}

// Older sessions saved only the text, without recording whether the caller supplied it.
const legacyBuiltInPrompts = new Set([
  "你是 Theta，一个模仿 pi1 的 coding agent demo。" +
    "你可以使用 read、write、edit、bash。涉及文件内容时先读取，不要猜测。" +
    "write 用于创建或完整覆盖；局部修改先 read 再 edit。" +
    "只执行用户任务所需的操作，修改完成后读取文件或运行合适命令核对。" +
    "bash 只运行短时非交互命令，不启动后台服务。" +
    "工具被策略拒绝时不要绕过限制，说明无法完成的部分。" +
    "最终回答区分已经完成与尚未验证的内容。",
  [
    "你是 Theta，一个在本地终端工作的 coding agent。",
    "本次没有注册工具。",
    "涉及文件内容时先读取。局部修改前先核对原文，修改完成后读取文件或运行合适命令核对。",
    "只执行用户任务所需的操作。命令限于短时非交互操作，不启动后台服务。",
    "工具被策略拒绝时不要绕过限制，说明无法完成的部分。",
    "最终回答区分已经完成与尚未验证的内容。",
  ].join("\n"),
  englishBasePrompt("No tools are available."),
]);

export function restoreSystemPrompt(saved: string): string {
  // Only the list of registered tool names varied within each of these templates.
  const template = saved
    .replace(/\n本次注册的工具：[\w-]+(?:、[\w-]+)*。\n/, "\n本次没有注册工具。\n")
    .replace(/\nAvailable tools: [\w-]+(?:, [\w-]+)*\.\n/, "\nNo tools are available.\n");
  return legacyBuiltInPrompts.has(template) ? `${saved}\n${replyLanguageInstruction}` : saved;
}
