import {
  Box, Editor, Text, TruncatedText, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type Component,
} from "@earendil-works/pi-tui";
import type { ToolStatus } from "../agent/hooks.ts";

const style = (code: string) => (text: string) => process.env.NO_COLOR !== undefined ? text : `\x1b[${code}m${text}\x1b[0m`;
export const accent = style("36;1");
export const muted = style("2");
export const selectTheme = { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: muted };
export const markdownTheme = {
  heading: style("1"), bold: style("1"), italic: style("3"), strikethrough: style("9"), underline: style("4"),
  link: style("4;36"), linkUrl: muted, code: style("36"), codeBlock: (s: string) => s, codeBlockBorder: muted,
  quote: (s: string) => s, quoteBorder: muted, hr: muted, listBullet: accent,
};

// Paths, model text and tool output may contain terminal controls. Only the UI emits styling.
export function display(text: string): string {
  return stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export class SessionHeader implements Component {
  private title: string;
  private path: string;

  constructor(version: string, path: string) {
    this.title = `${accent("Theta")}  ${muted(`v${version}`)}`;
    this.path = display(path).replace(/\n/g, " ");
  }

  invalidate(): void {}

  render(width: number): string[] {
    // Leave room for both borders and one cell of padding on each side.
    const label = muted("目录") + "  ";
    const pathWidth = visibleWidth(this.path);
    const available = width < 6 ? width : width - 5;
    const inner = Math.min(available, Math.max(24, visibleWidth(this.title), visibleWidth(label) + pathWidth));
    const pathBudget = Math.max(0, inner - visibleWidth(label));
    let path = this.path;
    if (pathWidth > pathBudget) {
      const lastSlash = path.lastIndexOf("/");
      const suffix = path.slice(Math.max(0, lastSlash));
      const parentBudget = pathBudget - visibleWidth(suffix);
      path = parentBudget > 0
        ? truncateToWidth(path.slice(0, lastSlash), parentBudget, "…") + suffix
        : "…" + sliceByColumn(path, pathWidth - pathBudget + 1, pathBudget - 1);
    }
    const content = [this.title, label + path].map(row => truncateToWidth(row, inner, "…"));
    if (width < 6) return content;
    const edge = "─".repeat(inner + 2);
    const rows = content.map(value => {
      return ` ${muted("│")} ${value}${" ".repeat(inner - visibleWidth(value))} ${muted("│")}`;
    });
    return [muted(` ╭${edge}╮`), ...rows, muted(` ╰${edge}╯`)];
  }
}

export class TaskEditor extends Editor {
  hasToolHistory = false;

  override render(width: number): string[] {
    const rows = super.render(width);
    // The native editor owns wrapping, scroll indicators, completion rows and the IME cursor.
    // Its three-cell left padding leaves room for the prompt on the first visible line.
    if (width >= 7) {
      rows[1] = " " + accent("›") + rows[1]!.slice(2);
      if (!this.getText()) {
        rows[1] = rows[1].trimEnd() + muted(truncateToWidth("输入任务，或用 / 查看命令", width - 4));
      }
    }
    const hint = this.capturesViewportInput
      ? "↑↓ 选择  ·  Tab 补全  ·  Esc 收起"
      : "Enter 发送  ·  Ctrl+J 换行" + (this.hasToolHistory ? "  ·  Ctrl+O 工具详情" : "");
    rows.push(muted(truncateToWidth(" " + hint, width)));
    return rows;
  }
}

export function userMessage(text: string): Text {
  return new Text(`${accent("›")} ${display(text)}`, 1, 0);
}

const toolLabels = { pending: "调用中", success: "完成", denied: "已拒绝", error: "失败", unconfirmed: "结果未确认" };
const toolColors = { pending: accent, success: muted, denied: style("33"), error: style("31;1"), unconfirmed: style("33") };

export class ToolBlock extends Box {
  private status: keyof typeof toolLabels = "pending";
  private output = "";
  private preview = "";
  private name: string;
  private target: string;
  private parameters: string;

  constructor(name: string, args?: unknown) {
    super(1, 0);
    this.name = display(name);
    const target = args && typeof args === "object"
      ? ("path" in args ? args.path : "command" in args ? args.command : undefined)
      : undefined;
    this.target = typeof target === "string" ? display(target).split("\n")[0] : "";
    this.parameters = args ? display(JSON.stringify(args, null, 2)) : "";
  }

  finish(status: ToolStatus | "unconfirmed", output: string, expanded: boolean): void {
    this.status = status;
    this.output = display(output).trimEnd();
    if (status !== "success") {
      let lines = this.output.split("\n");
      // Bash puts stderr after stdout. Preserve the exit status and show the
      // diagnostic even when many lines of stdout precede it.
      if (this.name === "bash" && status === "error" && lines[1] === "stdout:") {
        const stderr = lines.lastIndexOf("stderr:");
        if (stderr >= 2) {
          const diagnostics = lines.slice(stderr + 1).filter(line => line.trim());
          const stdout = lines.slice(2, stderr).filter(line => line.trim());
          lines = [lines[0], ...(diagnostics.length ? diagnostics : stdout)];
        }
      }
      this.preview = lines.slice(0, 3).map(line => truncateToWidth(line, 96, "…")).join("\n");
      if (this.preview !== this.output) this.preview += "\n…  Ctrl+O 展开";
    }
    this.setExpanded(expanded);
  }

  setExpanded(expanded: boolean): void {
    this.clear();

    const label = toolLabels[this.status];
    const status = toolColors[this.status](`● ${label}`);
    this.addChild(new TruncatedText(`${status}  ${this.name}  ${muted(this.target)}`));
    // Keep the exact arguments visible throughout an approval, including long write/edit content.
    if (expanded || (this.status === "pending" && this.name !== "read")) {
      this.addChild(new Text(this.parameters, 1, 0));
    }
    const output = expanded ? this.output : this.preview;
    if (output) this.addChild(new Text(output, 1, 0));
  }
}

export class SessionFooter implements Component {
  usage = "";
  model = "";

  invalidate(): void {}

  render(width: number): string[] {
    const contentWidth = Math.max(0, width - 2);
    const model = truncateToWidth(this.model, contentWidth, "…");
    const gap = contentWidth - visibleWidth(model) - visibleWidth(this.usage);
    const usage = this.usage && gap >= 2 ? " ".repeat(gap) + this.usage : "";
    return [muted(truncateToWidth(` ${model}${usage}`, width))];
  }
}
