import assert from "node:assert/strict";
import { link, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeTool } from "../src/agent/dispatch.ts";
import { createCodingPolicy } from "../src/coding-agent/coding-policy.ts";
import { createReadTool } from "../src/coding-agent/tools/read.ts";
import { editTool } from "../src/coding-agent/tools/edit.ts";
import { bashTool } from "../src/coding-agent/tools/bash.ts";
import { workspaceTest } from "./workspace.ts";

const signal = new AbortController().signal;

workspaceTest("edit 只修改唯一匹配，歧义和只读策略都会保留文件原文", async cwd => {
  const path = "note.txt";
  const file = join(cwd, path);
  await writeFile(file, "one one two");
  const call = { id: "edit-1", name: "edit", args: { path, oldText: "one", newText: "three" } };
  const ambiguous = await executeTool(call, [editTool], [], cwd, signal);
  assert.equal(ambiguous.status, "error");
  assert.equal(ambiguous.message.tool_call_id, call.id);
  assert.match(ambiguous.message.text, /不止一次/);
  assert.equal(await readFile(file, "utf8"), "one one two");
  call.args.oldText = "two";
  const policy = createCodingPolicy({ readOnly: true, stopAfterTurn: false }, () => {});
  assert.equal((await executeTool(call, [editTool], [policy], cwd, signal)).status, "denied");
  assert.equal(await readFile(file, "utf8"), "one one two");
  assert.equal((await executeTool(call, [editTool], [], cwd, signal)).status, "success");
  assert.equal(await readFile(file, "utf8"), "one one three");
});

workspaceTest("read 能读取普通文件，同时保护指向凭据的硬链接", async cwd => {
  const credential = join(cwd, "auth.json");
  await writeFile(credential, "private-example");
  await link(credential, join(cwd, "alias.txt"));
  await writeFile(join(cwd, "note.txt"), "hello");
  const read = createReadTool([credential]);
  const text = await read.prepare({ path: "note.txt" }).execute(cwd, signal);
  assert.equal(text, "hello");
  await assert.rejects(read.prepare({ path: "alias.txt" }).execute(cwd, signal), /无法读取 Theta 的登录凭据/);
});

workspaceTest("bash 的失败结果包含命令退出码和标准错误", async cwd => {
  const call = { id: "check", name: "bash", args: { command: "echo missing-input >&2; exit 7" } };
  const result = await executeTool(call, [bashTool], [], cwd, signal);
  assert.equal(result.status, "error");
  assert.equal(result.message.tool_call_id, "check");
  assert.match(result.message.text, /code=7/);
  assert.match(result.message.text, /stderr:\s*missing-input/);
});
