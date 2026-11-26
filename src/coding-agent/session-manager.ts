import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BaseMessage } from "@langchain/core/messages";
import { decodeMessage, encodeMessage } from "./message-codec.ts";
import { checkpointEntrySchema, compactionEntrySchema, messageEntrySchema, sessionHeaderSchema, sessionRecordSchema } from "./session-types.ts";
import type { CheckpointEntry, CompactionEntry, SessionEntry, SessionHeader, SessionRecord } from "./session-types.ts";

import { checkCheckpoint, recoverCheckpointCursor, type CheckpointCursor } from "./checkpoint.ts";
import { projectContext, validateSessionMessages, type ContextParts } from "./context.ts";

export class SessionManager {
  readonly filePath: string;
  private header: SessionHeader;
  private entries: SessionEntry[];
  private readonly recordIds: Set<string>;
  private cursor?: CheckpointCursor;
  private writing: boolean;
  private failed: boolean;

  private constructor(filePath: string, header: SessionHeader, entries: SessionEntry[], recordIds: Set<string>, cursor?: CheckpointCursor) {
    this.filePath = filePath;
    this.header = header;
    this.entries = entries;
    this.recordIds = recordIds;
    this.cursor = cursor;
    this.writing = false;
    this.failed = false;
  }

  static async create(cwd: string, messages: BaseMessage[]): Promise<SessionManager> {
    const root = await realpath(cwd);
    const header = sessionHeaderSchema.parse({
      type: "session",
      version: 3,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: root,
    });
    const entries: SessionEntry[] = [];
    for (const message of messages) {
      entries.push(messageEntrySchema.parse({
        type: "message",
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        message: encodeMessage(message),
      }));
    }

    const directory = join(root, ".theta", "sessions");
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, `${header.id}.jsonl`);
    const records: SessionRecord[] = [header, ...entries];
    const text = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(filePath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return new SessionManager(filePath, header, entries, new Set(records.map(record => record.id)));
  }

  static async load(filePath: string, cwd: string): Promise<SessionManager> {
    const root = await realpath(cwd);
    const absolutePath = resolve(root, filePath);
    const text = await readFile(absolutePath, "utf8");
    if (text === "" || !text.endsWith("\n")) {
      throw new Error(`${absolutePath}：会话为空或末行没有完整结束；本章不自动修复文件`);
    }

    const lines = text.slice(0, -1).split("\n");
    const ids = new Set<string>();
    const entries: SessionEntry[] = [];
    let header: SessionHeader | undefined;

    for (let index = 0; index < lines.length; index += 1) {
      try {
        const raw: unknown = JSON.parse(lines[index]);
        const record = sessionRecordSchema.parse(raw);
        if (ids.has(record.id)) {
          throw new Error(`记录 ID 重复：${record.id}`);
        }
        ids.add(record.id);

        if (index === 0) {
          if (record.type !== "session") {
            throw new Error("第一行必须是 session 头部");
          }
          if (record.cwd !== root) {
            throw new Error(`工作目录不一致：会话属于 ${record.cwd}，当前为 ${root}`);
          }
          header = record;
        } else {
          if (record.type === "session") {
            throw new Error("头部不能重复出现");
          }
          entries.push(record);
        }
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${absolutePath}:${index + 1}：${detail}`, { cause: error });
      }
    }

    if (header === undefined) {
      throw new Error(`${absolutePath}：缺少 session 头部`);
    }
    const cursor = recoverCheckpointCursor(entries, header.id);
    return new SessionManager(absolutePath, header, entries, ids, cursor);
  }

  static async latestPath(cwd: string): Promise<string> {
    const directory = join(cwd, ".theta", "sessions");
    const files = await readdir(directory, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    });
    const candidates = await Promise.all(files.filter(file => file.isFile() && file.name.endsWith(".jsonl"))
      .map(async file => {
        const path = join(directory, file.name);
        return { path, time: (await stat(path)).mtimeMs };
      }));
    const latest = candidates.sort((a, b) => b.time - a.time)[0];
    if (!latest) throw new Error(`当前目录没有可恢复的会话：${cwd}`);
    return latest.path;
  }

  get id(): string {
    return this.header.id;
  }

  // Records were validated at load or append. A later message makes the old boundary stale.
  get checkpoint(): CheckpointEntry | undefined {
    const tail = this.entries.at(-1);
    return !this.failed && tail?.type === "checkpoint" ? { ...tail } : undefined;
  }

  private readableEntries(): SessionEntry[] {
    if (this.failed) {
      throw new Error("会话曾写入失败，磁盘状态不确定；请检查文件后重新加载");
    }
    return this.entries;
  }

  getEntries(): SessionEntry[] {
    return structuredClone(this.readableEntries());
  }

  getContextSnapshot(): ContextParts {
    return structuredClone(projectContext(this.readableEntries()));
  }

  getHistoryMessages(): BaseMessage[] {
    const messages: BaseMessage[] = [];
    for (const entry of this.entries) {
      if (entry.type === "message") {
        messages.push(decodeMessage(structuredClone(entry.message)));
      }
    }
    return messages;
  }

  async appendMessage(message: BaseMessage): Promise<void> {
    const entry = messageEntrySchema.parse({
      type: "message",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      message: encodeMessage(message),
    });
    await this.appendEntry(entry);
  }

  async appendCompaction(entry: CompactionEntry): Promise<void> {
    const checked = compactionEntrySchema.parse(entry);
    projectContext([...this.entries, checked]);
    await this.appendEntry(checked);
  }

  async appendCheckpoint(
    next: CheckpointEntry["next"],
    turns: number,
    maxTurns: number,
  ): Promise<void> {
    const previous = this.entries.at(-1);
    if (previous === undefined) {
      throw new Error("没有历史记录，不能创建检查点");
    }
    const entry = checkpointEntrySchema.parse({
      type: "checkpoint",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: this.id,
      afterEntryId: previous.id,
      next, turns, maxTurns,
    });
    const end = this.entries.length;
    const cursor = checkCheckpoint(this.entries, end, entry, this.id, this.cursor);
    if (this.cursor) {
      validateSessionMessages(this.entries, this.cursor.nextIndex);
    } else {
      projectContext(this.entries);
    }
    await this.appendEntry(entry, cursor);
  }

  private async appendEntry(entry: SessionEntry, cursor?: CheckpointCursor): Promise<void> {
    if (this.failed) {
      throw new Error("会话之前保存失败，请检查文件后重新加载，不能直接重试追加");
    }
    if (this.writing) {
      throw new Error("会话正在写入，必须等待上一次追加结束");
    }
    if (this.recordIds.has(entry.id)) {
      throw new Error(`记录 ID 重复：${entry.id}`);
    }
    this.writing = true;
    try {
      await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf8");
      this.entries.push(entry);
      this.recordIds.add(entry.id);
      if (cursor) this.cursor = cursor;
    } catch (error: unknown) {
      this.failed = true;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`保存会话失败 ${this.filePath}：${detail}`, { cause: error });
    } finally {
      this.writing = false;
    }
  }
}
