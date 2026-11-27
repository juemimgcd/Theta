# 参与 Theta

可以用中文或英文提交 issue 和 PR。提交前先[搜索已有 issue](https://github.com/juemimgcd/Theta/issues)，同一问题的复现线索可以直接补在原讨论里。

## 提交 issue

在[新建 issue](https://github.com/juemimgcd/Theta/issues/new/choose) 时，选择与你的问题对应的表单。标题写出具体操作和结果，例如「管道输入第二行时丢失上一轮上下文」。

| 入口 | 需要提供的信息 |
| --- | --- |
| 故障报告 | 实际与预期行为、最短复现步骤、操作系统和 Bun / Theta 版本。偶发故障可写最近一次操作顺序。 |
| 功能建议 | 想完成的任务、当前限制，以及一个能说明预期行为的例子。 |
| 文档问题 | 页面、文件或章节，以及读者在哪一步会遇到困难。 |

贴终端输出前请遮盖密钥和私有代码。Theta 的会话日志可能包含提示词、工具参数和文件内容，通常贴几行脱敏片段就足够。

## 维护者如何使用标签

表单会添加 `bug`、`enhancement` 或 `documentation`，并加上 `status: triage`。维护者第一次查看后移除 `status: triage`。需要提交者补充信息时，写清缺少什么并加上 `status: needs info`，收到信息后移除。

按影响范围选用下列标签。跨模块的问题可以选多个。

| 标签 | 适用范围 |
| --- | --- |
| `area: cli` | 命令行参数、管道输入、终端显示和交互 |
| `area: agent` | 模型调用循环、工具调度、工具执行和权限 |
| `area: session` | 会话存储、恢复、检查点和上下文压缩 |
| `area: models` | 模型适配、服务商登录和模型选择 |
| `area: ci` | GitHub Actions、依赖审计和仓库维护流程 |

欢迎外部贡献时加 `help wanted`。若任务范围清楚、有明确的代码入口和验收方式，也适合加 `good first issue`。

## 提交 PR

1. 从 `main` 创建分支，一个 PR 解决一个问题。小修复和文档改进可以直接开 PR。涉及新命令、权限行为或会话格式时，建议先开 issue 对齐预期。
2. 标题采用 `<type>(<scope>): <summary>`。例如 `fix(session): 修复恢复后重复显示工具结果` 或 `docs(cli): 补充管道输入示例`。
3. 在描述里写明原行为、改动原因和验证结果。有对应 issue 时附链接，合并即可解决时写 `Closes #编号`。命令、配置或用户可见行为发生变化时，同步更新相关说明。
4. 按改动验证。代码改动使用 [package.json](package.json) 指定的 Bun 版本运行下面的命令。CLI 输出改动附一段实际输出，TUI 改动可用截图展示。仅改文档时核对受影响的链接、命令或示例。

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test
bun examples/session-flow.ts
```

提交后查看 [CLI checks](.github/workflows/ci.yml) 的 Ubuntu 和 macOS 结果。两项检查通过并处理完审阅意见后，再合并。
