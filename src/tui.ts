import { homedir } from "node:os";
import { relative, sep } from "node:path";
import type { BaseMessage } from "@langchain/core/messages";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import {
  CombinedAutocompleteProvider, Container, CURSOR_MARKER, Editor, getKeybindings, hyperlink, Input, Markdown, ProcessTerminal,
  ScrollView, SelectList, Spacer, stripTerminalSequences, Text, TruncatedText, truncateToWidth, TuiAltScreen, VStack,
  type Component, type SelectItem,
} from "@earendil-works/pi-tui";
import type { AccountUI } from "./accounts.ts";
import type { AgentEvent } from "./events.ts";
import type { ToolHookCall } from "./hooks.ts";

const commands = [
  { name: "login", description: "登录服务商" }, { name: "model", description: "切换模型" },
  { name: "status", description: "查看模型与登录状态" }, { name: "providers", description: "列出服务商及登录方式" },
  { name: "logout", description: "移除已保存的凭据" }, { name: "compact", description: "压缩会话历史" },
  { name: "help", description: "显示命令" }, { name: "exit", description: "退出 Theta" },
];
export const commandHelp = commands.map(c => `/${c.name}  ${c.description}`).join("\n");

const style = (code: string) => (text: string) => process.env.NO_COLOR !== undefined ? text : `\x1b[${code}m${text}\x1b[0m`;
const accent = style("36;1");
const muted = style("2");
const selectTheme = { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: muted };
const markdownTheme = {
  heading: style("1"), bold: style("1"), italic: style("3"), strikethrough: style("9"), underline: style("4"),
  link: style("4;36"), linkUrl: muted, code: style("36"), codeBlock: (s: string) => s, codeBlockBorder: muted,
  quote: (s: string) => s, quoteBorder: muted, hr: muted, listBullet: accent,
};

// Tool output, model text and paths are terminal input boundaries. Preserve line breaks,
// but never let their escape sequences move the cursor or change terminal state.
function display(text: string): string {
  return stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

class SecretInput extends Input {
  override render(width: number): string[] {
    return [truncateToWidth("  › " + "•".repeat(Math.min(24, this.getValue().length)), Math.max(1, width - 1)) + CURSOR_MARKER];
  }
}

class ApprovalList extends SelectList {
  override readonly capturesViewportInput = false;
}

type ApprovalPrompt = {
  type: "approval";
  message: string;
  options: Extract<AuthPrompt, { type: "select" }>["options"];
};

class Picker extends Container {
  readonly capturesViewportInput = true;
  private search = new Input({ prompt: "  / ", placeholder: "输入前缀筛选", placeholderStyle: muted });
  private list: SelectList;

  constructor(items: SelectItem[], done: (value: string) => void) {
    super();
    this.list = new SelectList(items, 7, selectTheme);
    this.list.onSelect = item => done(item.value);
    this.search.focused = true;
    this.addChild(this.search);
    this.addChild(this.list);
  }

  handleInput(data: string): void {
    const before = this.search.getValue();
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down") ||
        keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown") ||
        keys.matches(data, "tui.select.confirm")) {
      this.list.handleInput(data);
    } else {
      this.search.handleInput(data);
      if (before !== this.search.getValue()) this.list.setFilter(this.search.getValue().trim());
    }
  }
}

export class TerminalUI {
  private screen = new TuiAltScreen(new ProcessTerminal(), true, undefined, { mouse: false });
  private transcript = new Container();
  private scroll = new ScrollView(this.transcript, { primary: true, follow: "end", scrollbar: "auto" });
  private controls = new Container();
  private footer = new Text("", 1, 0);
  private editor = new Editor(this.screen, { borderColor: muted, selectList: selectTheme }, { paddingX: 1 });
  private reply?: Text;
  private replyText = "";
  private usage = "";
  private interrupted: () => void = () => {};
  private waiting = "正在处理";
  private sessionFile?: string;
  private modelLabel: () => string;

  constructor(cwd: string, modelLabel: () => string) {
    this.modelLabel = modelLabel;
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, cwd));
    const path = cwd.startsWith(homedir() + sep) ? "~" + cwd.slice(homedir().length) : cwd;
    const header = new TruncatedText(`${accent("Theta")}  ${display(path)}`, 1, 0);
    this.screen.setLayoutRoot(new VStack([header,
      { component: this.scroll, grow: 1, basis: 0, minSize: 1 }, this.controls, this.footer]));
    this.screen.addInputListener(data => {
      const keys = getKeybindings();
      if (keys.matches(data, "tui.input.copy") || (keys.matches(data, "tui.select.cancel") && !this.editor.focused)) {
        this.interrupted();
        return { consume: true };
      }
    });
  }

  start(): void { this.screen.start(); }
  stop(): void { this.screen.stop({ preserveScreen: true }); }
  interrupt(): void { this.interrupted(); }

  setSession(path: string | undefined): void {
    this.sessionFile = path;
  }

  status(): string {
    return this.sessionFile ? `会话文件  ${relative(process.cwd(), this.sessionFile)}` : "当前尚未创建会话。";
  }

  restore(messages: BaseMessage[]): void {
    for (const message of messages) {
      if (message.type === "human" || message.type === "ai") this.event({ type: "message_end", message });
      if (message.type === "tool") this.say(`  ${message.name ?? "工具"}  ${truncateToWidth(display(message.text).split("\n")[0], 100)}`);
    }
  }

  say(message: string): void {
    this.transcript.addChild(new Text(display(message), 1, 0));
    this.screen.requestRender();
  }

  log(message: string): void {
    if (message.startsWith("[usage] ")) this.usage = message.slice(8);
    else this.say(message);
  }

  event(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        if (!this.reply) {
          this.transcript.addChild(new Text(accent("Theta"), 1, 0));
          this.reply = new Text("", 1, 0);
          this.transcript.addChild(this.reply);
        }
        this.replyText += event.text;
        this.reply.setText(display(this.replyText));
        break;
      case "message_end":
        if (event.message.type === "human") {
          this.transcript.addChild(new Spacer(1));
          this.transcript.addChild(new Text(`${accent("›")} ${display(event.message.text)}`, 1, 0));
        } else if (event.message.type === "ai") {
          if (this.reply) this.transcript.removeChild(this.reply);
          if (event.message.text) {
            if (!this.reply) this.transcript.addChild(new Text(accent("Theta"), 1, 0));
            this.transcript.addChild(new Markdown(display(event.message.text), 1, 0, markdownTheme));
          }
          this.reply = undefined;
          this.replyText = "";
        }
        break;
      case "tool_start": this.busy(`调用 ${event.name}`); break;
      case "tool_end": {
        const status = { success: "完成", denied: "已拒绝", error: "失败" }[event.status];
        const detail = display(event.raw).trim().split("\n").slice(0, 2).join("  ");
        this.say(`  ${event.name} · ${status}  ${truncateToWidth(detail, 100)}`);
        this.busy("等待模型");
        break;
      }
      case "agent_end":
        this.reply = undefined;
        this.replyText = "";
        break;
    }
    this.screen.requestRender();
  }

  private show(component: Component | null, hint: string): void {
    this.controls.clear();
    if (component) this.controls.addChild(component);
    this.screen.setFocus(component);
    this.footer.setText(`${display(this.modelLabel())}  ·  ${hint}`);
    this.screen.requestRender();
  }

  busy(label: string, cancel?: () => void): void {
    this.waiting = label;
    if (cancel) this.interrupted = cancel;
    this.show(null, `${display(label)}  ·  Esc 取消`);
  }

  read(): Promise<string> {
    this.show(this.editor, [this.usage, "Enter 发送", "Ctrl+J 换行", "/help"].filter(Boolean).join("  ·  "));
    return new Promise(resolve => {
      this.interrupted = () => resolve("/exit");
      this.editor.onSubmit = text => {
        if (!text.trim()) return;
        this.editor.addToHistory(text);
        this.scroll.scrollToEnd();
        resolve(text.trim());
      };
    });
  }

  interaction(signal: AbortSignal): AccountUI {
    return { signal, say: text => this.say(text), notify: event => this.notify(event),
      prompt: prompt => this.ask(prompt, signal) };
  }

  private notify(event: AuthEvent): void {
    switch (event.type) {
      case "auth_url":
      case "device_code": {
        const url = new URL(event.type === "auth_url" ? event.url : event.verificationUri);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("授权链接需要 HTTP 或 HTTPS 地址。");
        this.say(event.type === "auth_url" ? event.instructions ?? "在浏览器中打开链接完成授权" : `请在授权页面输入设备码  ${event.userCode}`);
        this.transcript.addChild(new Text(hyperlink(accent(`打开 ${url.host} 授权页面`), url.href), 1, 0));
        this.say(url.href);
        break;
      }
      case "info": this.say([event.message, ...(event.links ?? []).map(link => link.url)].join("\n")); break;
      case "progress": this.say(event.message); break;
    }
  }

  private async ask(prompt: AuthPrompt | ApprovalPrompt, operation: AbortSignal): Promise<string> {
    const signal = "signal" in prompt && prompt.signal ? AbortSignal.any([operation, prompt.signal]) : operation;
    signal.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        if (prompt.type === "approval") this.scroll.scrollToEnd();
        this.busy(this.waiting);
      };
      const abort = () => { finish(); reject(signal.reason); };
      const submit = (value: string) => { finish(); resolve(value); };
      const panel = new Container();
      panel.addChild(new Text(display(prompt.message), 1, 0));
      let field: Component;
      let hint = "Enter 提交  ·  Esc 取消";
      if (prompt.type === "select" || prompt.type === "approval") {
        const items = prompt.options.map(o => ({ value: o.id, label: display(o.label), description: display(o.description ?? "") }));
        hint = "↑↓ 选择  ·  Enter 确认  ·  Esc 取消";
        if (prompt.type === "select" && items.length > 7) field = new Picker(items, submit);
        else {
          const List = prompt.type === "approval" ? ApprovalList : SelectList;
          const list = new List(items, 7, selectTheme);
          list.onSelect = item => submit(item.value);
          field = list;
        }
        if (prompt.type === "approval") hint = "PgUp/PgDn 查看参数  ·  " + hint;
      } else {
        const input = prompt.type === "text" ? new Input({ prompt: "  › ", placeholder: display(prompt.placeholder ?? "") }) : new SecretInput();
        input.onSubmit = value => {
          if (prompt.type === "secret" && !value.trim()) { this.say("请输入凭据，或按 Esc 取消。"); return; }
          submit(value.trim());
        };
        field = input;
      }
      panel.addChild(field);
      this.show(panel, hint);
      this.screen.setFocus(field);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async approve(call: ToolHookCall, signal: AbortSignal): Promise<string | void> {
    if (call.name === "read") {
      this.say(`  read  ${JSON.stringify(call.args)}`);
      return;
    }
    this.say(`${call.name}\n${JSON.stringify(call.args, null, 2)}`);
    const value = await this.ask({ type: "approval", message: `允许执行 ${call.name}？`,
      options: [{ id: "no", label: "拒绝本次" }, { id: "yes", label: "允许本次" }] }, signal);
    if (value !== "yes") return "用户拒绝了本次工具调用";
  }
}
