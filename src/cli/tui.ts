import { homedir } from "node:os";
import { relative, sep } from "node:path";
import { isAIMessage, isToolMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import {
  CombinedAutocompleteProvider, Container, CURSOR_MARKER, getKeybindings, hyperlink, Input, isKeyRelease, isKeyRepeat,
  Markdown, matchesKey, ProcessTerminal,
  ScrollView, SelectList, Spacer, Text, truncateToWidth, TuiAltScreen, VStack,
  type AutocompleteItem, type Component, type SelectItem,
} from "@earendil-works/pi-tui";
import metadata from "../../package.json" with { type: "json" };
import { accent, display, markdownTheme, muted, selectTheme, SessionFooter, SessionHeader, TaskEditor, ToolBlock, userMessage } from "./tui-components.ts";
import type { AccountUI } from "../coding-agent/accounts.ts";
import type { AgentEvent } from "../agent/events.ts";
import type { ToolHookCall } from "../agent/hooks.ts";

const commands = [
  { name: "login", description: "登录服务商" }, { name: "model", description: "切换模型" },
  { name: "status", description: "查看模型与登录状态" }, { name: "providers", description: "列出服务商及登录方式" },
  { name: "logout", description: "移除已保存的凭据" }, { name: "compact", description: "压缩会话历史" },
  { name: "resume", description: "继续中断的任务" }, { name: "new", description: "开启新会话" },
  { name: "help", description: "显示命令" }, { name: "exit", description: "退出 Theta" },
];
export const commandHelp = commands.map(c => `/${c.name}  ${c.description}`).join("\n");

class CommandAutocomplete extends CombinedAutocompleteProvider {
  override applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
    // A key can arrive before the slash menu refreshes. Apply its selection only
    // to the command prefix that produced it, never to newly typed arguments.
    if (prefix.startsWith("/") && commands.some(command => command.name === item.value)) {
      const beforeCursor = lines[cursorLine].slice(0, cursorCol).trimStart();
      if (cursorLine !== 0 || beforeCursor !== prefix) return { lines, cursorLine, cursorCol };
    }
    return super.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }
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
  private footer = new SessionFooter();
  private editor = new TaskEditor(this.screen, { borderColor: muted, selectList: selectTheme }, { paddingX: 3 });
  private reply?: Markdown;
  private replyText = "";
  private calls: AIMessage["tool_calls"] = [];
  private pendingTools = new Map<string, ToolBlock>();
  private toolsExpanded = false;
  private interrupted: () => void = () => {};
  private waiting = "正在处理";
  private sessionFile?: string;
  private modelLabel: () => string;

  constructor(cwd: string, modelLabel: () => string) {
    this.modelLabel = modelLabel;
    this.editor.setAutocompleteProvider(new CommandAutocomplete(commands, cwd));
    const path = cwd === homedir() ? "~" : cwd.startsWith(homedir() + sep) ? "~" + cwd.slice(homedir().length) : cwd;
    this.transcript.addChild(new Spacer(1));
    this.transcript.addChild(new SessionHeader(metadata.version, path));
    this.transcript.addChild(new Spacer(1));
    this.screen.setLayoutRoot(new VStack([
      { component: this.scroll, grow: 1, basis: 0, minSize: 1 }, this.controls, this.footer]));
    this.screen.addInputListener(data => {
      if (matchesKey(data, "ctrl+o")) {
        if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
        this.toolsExpanded = !this.toolsExpanded;
        for (const child of this.transcript.children) {
          if (child instanceof ToolBlock) child.setExpanded(this.toolsExpanded);
        }
        this.screen.requestRender();
        return { consume: true };
      }
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
    if (this.sessionFile === path) return;
    this.finishRun();
    this.sessionFile = path;
    this.footer.usage = "";
  }

  status(): string {
    return this.sessionFile ? `会话文件  ${relative(process.cwd(), this.sessionFile)}` : "当前尚未创建会话。";
  }

  restore(messages: BaseMessage[]): void {
    for (const message of messages) {
      if (isToolMessage(message)) {
        const tool = this.addTool(message.name ?? "工具", message.tool_call_id);
        const text = message.text;
        const status = message.status === "error" && text.startsWith("[工具状态：denied]\n")
          ? "denied" : message.status ?? "success";
        const output = status === "success" ? text : text.replace(/^\[工具状态：(denied|error)\]\n/, "");
        tool.finish(status, output, this.toolsExpanded);
      } else {
        this.event({ type: "message_end", message });
      }
    }
  }

  say(message: string): void {
    this.transcript.addChild(new Text(display(message), 1, 0));
    this.screen.requestRender();
  }

  log(message: string): void {
    // Usage is rendered from the AI message itself, including when replaying a saved session.
    if (!message.startsWith("[usage] ")) this.say(message);
  }

  private addTool(name: string, id: string, args: unknown = this.calls?.find(call => call.id === id)?.args): ToolBlock {
    const block = new ToolBlock(name, args);
    this.editor.hasToolHistory = true;
    this.transcript.addChild(new Spacer(1));
    this.transcript.addChild(block);
    return block;
  }

  private updateReply(text: string): void {
    if (!this.reply) {
      this.transcript.addChild(new Spacer(1));
      this.reply = new Markdown("", 1, 0, markdownTheme);
      this.transcript.addChild(this.reply);
    }
    this.reply.setText(display(text));
  }

  private finishRun(): void {
    for (const tool of this.pendingTools.values()) {
      tool.finish("unconfirmed", "", this.toolsExpanded);
    }
    this.pendingTools.clear();
    this.calls = [];
    this.reply = undefined;
    this.replyText = "";
  }

  event(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        this.replyText += event.text;
        this.updateReply(this.replyText);
        break;
      case "message_end": {
        const message = event.message;
        if (message.type === "human") {
          this.transcript.addChild(new Spacer(1));
          this.transcript.addChild(userMessage(message.text));
        } else if (isAIMessage(message)) {
          if (message.text || this.reply) this.updateReply(message.text);
          this.reply = undefined;
          this.replyText = "";
          this.calls = message.tool_calls;
          const usage = message.usage_metadata;
          if (usage) this.footer.usage = `↑ ${usage.input_tokens}  ↓ ${usage.output_tokens} tokens`;
        }
        break;
      }
      case "tool_start": this.busy(`调用 ${event.name}`); break;
      case "tool_end": {
        const tool = this.pendingTools.get(event.callId) ?? this.addTool(event.name, event.callId);
        tool.finish(event.status, event.raw, this.toolsExpanded);
        this.pendingTools.delete(event.callId);
        this.busy("等待模型");
        break;
      }
      case "agent_end":
        this.finishRun();
        break;
    }
    this.screen.requestRender();
  }

  private show(component: Component | null, hint = ""): void {
    this.controls.clear();
    if (component) this.controls.addChild(component);
    this.screen.setFocus(component);
    if (hint) this.controls.addChild(new Text(muted(hint), 1, 0));
    this.footer.model = display(this.modelLabel()).replace(/\n/g, " ");
    this.screen.requestRender();
  }

  busy(label: string, cancel?: () => void): void {
    this.waiting = label;
    if (cancel) this.interrupted = cancel;
    this.show(new Text(`${accent("●")} ${display(label)}`, 1, 0), "Esc 取消");
  }

  read(): Promise<string> {
    this.show(this.editor);
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
      panel.addChild(new Text(prompt.type === "approval" ? accent(display(prompt.message)) : display(prompt.message), 1, 0));
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
    const tool = this.addTool(call.name, call.id, call.args);
    this.pendingTools.set(call.id, tool);
    tool.setExpanded(this.toolsExpanded);
    this.screen.requestRender();
    if (call.name === "read") return;
    this.scroll.scrollToEnd();
    const value = await this.ask({ type: "approval", message: `允许执行 ${call.name}？`,
      options: [{ id: "no", label: "拒绝本次" }, { id: "yes", label: "允许本次" }] }, signal);
    if (value !== "yes") return "用户拒绝了本次工具调用";
  }
}
