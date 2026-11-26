import {
  Box, Text, TruncatedText, stripTerminalSequences, truncateToWidth, visibleWidth, type Component,
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

export function userMessage(text: string): Text {
  return new Text(`› ${display(text)}`, 1, 1, style("38;5;231;48;5;60"));
}

const toolLabels = { pending: "调用中", success: "完成", denied: "已拒绝", error: "失败", unconfirmed: "结果未确认" };
const toolBackgrounds = {
  pending: style("38;5;253;48;5;237"), success: style("38;5;194;48;5;22"),
  denied: style("38;5;230;48;5;58"), error: style("38;5;224;48;5;52"), unconfirmed: style("38;5;253;48;5;237"),
};

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
    this.preview = this.output.split("\n", 3).map(line => truncateToWidth(line, 96, "…")).join("\n");
    if (this.preview !== this.output) this.preview += "\n…  Ctrl+O 展开";
    this.setExpanded(expanded);
  }

  setExpanded(expanded: boolean): void {
    this.clear();
    this.setBgFn(toolBackgrounds[this.status]);
    const label = toolLabels[this.status];
    this.addChild(new TruncatedText(`${this.name} · ${label}  ${this.target}`));
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
  private path: string;

  constructor(path: string) {
    this.path = display(path).replace(/\n/g, " ");
  }

  invalidate(): void {}

  render(width: number): string[] {
    const model = truncateToWidth(this.model, width, "…");
    const usage = truncateToWidth(this.usage, Math.max(0, width - visibleWidth(model) - 2), "…");
    const gap = " ".repeat(Math.max(0, width - visibleWidth(usage) - visibleWidth(model)));
    return [muted(truncateToWidth(this.path, width, "…")), muted(usage + gap + model)];
  }
}
