# Theta

[Theta 官网](https://juemimgcd.github.io/Theta/)

Theta 是一个在终端中运行的编程助手。它可以读取项目代码、编辑文件、执行 shell 命令，并根据工具返回的结果继续工作。对话和工具结果保存在项目目录中，退出后可以从上次的检查点继续。

Theta 使用 TypeScript 和 Bun 实现。服务商登录、模型目录和终端组件来自 [pi](https://github.com/earendil-works/pi)。Theta 自己管理工具执行、会话恢复，以及每次请求发送给模型的上下文。

## 快速开始

安装 [package.json](package.json) 中 `packageManager` 指定的 Bun 版本后，从源码注册 `theta` 命令。

```sh
git clone https://github.com/juemimgcd/Theta.git
cd Theta
bun install --frozen-lockfile --ignore-scripts
bun link
theta --help
```

如果 shell 找不到 `theta`，将 `bun pm bin -g` 输出的目录加入 `PATH`。也可以直接在源码目录运行 `bun start`。

在要处理的项目目录中运行 `theta`。首次使用时输入 `/login`，按提示登录服务商并选择模型。已有服务商环境凭据时，可以直接输入 `/model`。在 Theta 仓库里，可以先让它追踪一条真实的调用路径。

```text
读取 src/cli/main.ts，说明运行 theta 和 theta "任务" 分别会进入哪种模式。
```

## 使用方式

**交互对话。** 运行 `theta` 打开终端界面。回复以 Markdown 流式显示。按 `Enter` 发送，`Ctrl+J` 换行，`↑` 在空输入框中调出上一条输入。成功的工具调用默认只显示一行摘要，失败或拒绝时会显示原因。按 `Ctrl+O` 可展开或收起完整参数和输出。启动时的会话标题显示工作目录，输入框下方显示当前模型，空间足够时还会显示最近一次回复的输入和输出 token 数。

**单次任务。** 把任务作为命令行参数传入。成功时，Theta 将最终回答写入标准输出，将诊断信息写入标准错误，方便在脚本中分别处理。下面的命令以只读模式查看项目脚本。

```sh
THETA_READ_ONLY=1 theta "读取 package.json，列出可用的开发命令"
```

**管道输入。** 不带任务参数时，Theta 可以从标准输入逐行读取指令，在同一会话中依次执行。第二个问题可以引用第一个问题的回答。

```sh
printf '%s\n' '读取 package.json，说明启动方式' '列出刚才提到的测试命令' | THETA_READ_ONLY=1 theta
```

| 对话命令 | 用途 |
| --- | --- |
| `/help`、`/exit` | 查看命令列表，或退出会话 |
| `/providers`、`/login`、`/logout` | 查看服务商和登录方式，管理本地凭据 |
| `/model`、`/status` | 切换模型，查看当前配置和会话文件路径 |
| `/compact` | 汇总较早的对话或工具轮次，为后续请求腾出上下文空间 |
| `/resume`、`/new` | 继续当前会话中断的任务，或让下一条输入开启新会话 |

## 工具与权限

| 工具 | 行为 |
| --- | --- |
| `read` | 读取不超过 1 MB 的文本文件。用 `offset`（从 1 开始）和 `limit` 按行分页 |
| `edit` | 精确替换一处文本。旧文本缺失或匹配多处时返回错误 |
| `write` | 创建文件或覆盖整个文件，按需创建父目录 |
| `bash` | 在工作目录中运行非交互命令，返回退出状态和输出。默认超时 10 秒，最长 60 秒 |

工具以启动 Theta 的用户权限执行，相对路径以启动目录为基准。**在 TUI 中，`write`、`edit` 和 `bash` 需要逐次确认。** 审批时会显示完整参数，可用 `PageUp`、`PageDown` 翻阅。选择“拒绝本次”会将拒绝原因返回给模型，按 `Esc` 或 `Ctrl+C` 则取消当前任务。

单次任务和管道模式直接执行工具。设置 `THETA_READ_ONLY=1` 可以将工具权限限制为 `read`。读取的文件内容和命令输出可能随下一轮请求发送给模型。内置 `read` 会拒绝读取默认和当前账号目录中的 `auth.json` 与 `models.json`。

## 会话与恢复

会话按行追加到启动目录下的 `.theta/sessions/<会话 ID>.jsonl`，其中保存对话、按调用 ID 配对的工具结果、摘要和检查点。恢复时请回到原项目目录，同一会话文件一次只由一个进程写入。

| 你要做什么 | 命令 |
| --- | --- |
| 打开当前目录最近写入的会话 | `theta --resume` |
| 继续指定会话中等待模型响应的任务 | `theta --resume <会话文件>` |
| 在已等待用户输入的会话里追问 | `theta --session <会话文件> "新问题"` |

检查点记录下一步是请求模型还是等待用户输入，以及当前任务已经完成的轮数。例如，若一次 `edit` 的结果和等待模型的检查点均已保存，恢复时模型会读到编辑结果，继续下一轮推理。若日志只有工具调用、缺少对应结果，Theta 会拒绝自动继续。此时应先检查目标文件，确认操作是否生效。

上下文接近预算时，Theta 会尝试把早期交互压缩为摘要。后续请求使用系统指令、摘要和近期原文。若单个任务跨越多轮工具调用，也可以汇总其中已完成的较早轮次，同时保留原始任务和最近一批工具结果。压缩记录追加到会话文件，原始消息仍可查阅。

## 配置

### 服务商与账号

运行 `theta providers` 查看当前版本支持的服务商及登录方式。也可以在 shell 中登录或切换模型。

```sh
theta login deepseek             # 使用 API Key 登录并选择模型
theta login openai-codex oauth   # 使用 OAuth 登录
theta model                      # 从已配置的服务商中选择模型
theta status                     # 查看当前模型和已配置的服务商
```

账号目录默认为 `~/.theta/`。`auth.json` 保存凭据，`settings.json` 保存模型选择，`models.json` 可按 pi 的格式配置自定义服务商。需要隔离账号时，在子命令前指定目录，例如 `theta --theta-home ~/.theta-work login`。后续启动也传入同一目录。

### OpenAI 兼容接口

在 shell 或项目启动目录的 `.env` 中设置 `OPENAI_API_KEY` 和 `OPENAI_MODEL`。使用自定义网关时，再设置 `OPENAI_BASE_URL`，包含服务商要求的路径前缀。模型需支持 Chat Completions 和工具调用，交互对话还需支持流式响应。

已通过 `/model` 选定的服务商模型优先。运行 `theta model env` 可切回环境变量配置。配置自定义网关后，`OPENAI_API_KEY` 用于该端点。要同时使用模型目录中的 OpenAI 服务，请通过 `theta login openai` 单独配置凭据。

### 运行选项

| 环境变量 | 用途 |
| --- | --- |
| `THETA_READ_ONLY=1` | 仅允许调用 `read` |
| `THETA_CONTEXT_WINDOW` | 设置上下文窗口的 token 数，默认 32768，最小 8192。选择目录模型时还受该模型窗口限制 |
| `THETA_COMPACT_AT` | 设置触发压缩的估算 token 数，默认取扣除工具声明、输出和预留空间后消息预算的 75% |
| `THETA_DEBUG_CONTEXT=1` | 输出主请求序号、消息数量和实际发送的消息内容，便于检查上下文 |
| `THETA_STOP_AFTER_TURN=1` | 在首个包含工具调用的轮次完成后停止任务，便于检查工具结果 |

Theta 按序列化消息的 UTF-8 字节数估算 token 用量。以上五项也支持同名的 `ALPHA_*` 配置。两种前缀同时存在时，优先使用 `THETA_*`。

## 开发

```sh
bun run check                 # TypeScript 类型检查
bun test                      # 运行测试
bun examples/session-flow.ts  # 离线演示会话写入与恢复
```

每个 PR 和推送到 `main` 的提交都会触发 [CLI 检查](.github/workflows/ci.yml)。Ubuntu 和 macOS 分别运行以上三条命令，再通过 `bun link` 注册 CLI，从仓库外运行 `theta --help`。[依赖审计](.github/workflows/audit.yml) 每周一检查锁文件中生产依赖的中等及以上级别漏洞，也可以在 GitHub Actions 中手动运行。

Theta 是 Alpha 七章教程的 TypeScript 重写。从终端入口跟到会话存储，可以看到一次工具调用如何变成可恢复的记录。

| 模块 | 职责 |
| --- | --- |
| [终端入口](src/cli/task-mode.ts) | 选择交互或单次任务模式，将用户输入和审批结果交给会话 |
| [Agent 循环](src/agent/agent-loop.ts) | 请求模型，等待完整响应，执行工具调用，再将结果带入下一轮 |
| [模型适配](src/models/) | 将服务商响应转换为 LangChain 消息，聚合流式文本与工具参数，估算请求预算 |
| [工具调度](src/agent/dispatch.ts) | 校验参数，运行工具前后的 Hook，记录实际结果 |
| [AgentSession](src/coding-agent/agent-session.ts) | 协调任务执行、[上下文压缩](src/coding-agent/compact.ts)和[检查点恢复](src/coding-agent/checkpoint.ts) |
| [SessionManager](src/coding-agent/session-manager.ts) | 追加和校验 JSONL 记录，读取会话历史并构建[上下文快照](src/coding-agent/context.ts) |

后续计划包括会话分支，以及运行中的指令追加与任务排队。
