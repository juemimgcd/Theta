import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseArgs } from "../src/cli/args.ts";

test("区分恢复最近会话和在指定会话提交新问题", () => {
  assert.deepEqual(parseArgs(["--resume"]).command, {
    kind: "task", resume: true, latest: true, file: undefined, task: "",
  });
  assert.deepEqual(parseArgs(["--session", "a.jsonl", "继续", "读码"]).command, {
    kind: "task", resume: false, latest: false, file: "a.jsonl", task: "继续 读码",
  });
  assert.throws(() => parseArgs(["--resume", "a.jsonl", "新问题"]), /不能同时提交新问题/);
  assert.throws(() => parseArgs(["--session"]), /指定会话文件/);
});

test("解析独立账号目录时保留模型选择参数", () => {
  assert.deepEqual(parseArgs(["--theta-home", "./accounts", "model", "env"]), {
    directory: resolve("./accounts"), command: { kind: "account", name: "model", args: ["env"] },
  });
  assert.throws(() => parseArgs(["--theta-home", "--help"]), /需要指定账号目录/);
});
