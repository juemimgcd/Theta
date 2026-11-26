import type { AgentSession } from "./agent-session.ts";

/** Current session and the history to open after switching models. */
export class SessionConnection {
  current?: AgentSession;
  path?: string;
  private readonly create: (path?: string) => Promise<AgentSession>;

  constructor(path: string | undefined, create: (path?: string) => Promise<AgentSession>) {
    this.path = path;
    this.create = create;
  }

  async open(): Promise<AgentSession> {
    return this.current ??= await this.create(this.path);
  }

  reconnect(): void {
    if (this.current) {
      this.path = this.current.filePath;
      this.current = undefined;
    }
  }

  startNew(): void {
    this.path = undefined;
    this.current = undefined;
  }
}
