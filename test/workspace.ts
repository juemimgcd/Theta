import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

export function workspaceTest(name: string, run: (cwd: string) => Promise<void>): void {
  test(name, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "theta-test-"));
    try {
      await run(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
