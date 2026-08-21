# Spec: module-bridge-shim — 千问办公 → Claude Code 桥接翻译层

实现契约。目标：让 Agent 完成任务时，从「千问办公 UI → qoder CLI」改道为「千问办公 UI → claude CLI」。

## 要实现什么

一个 Node.js 翻译层（`src/bridge-shim.mjs`），被 `@qoder-ai/qoder-agent-sdk` 的 ProcessTransport 当作「qoder CLI」spawn（通过 `QODER_CLI_PATH` 环境变量触发）。它：

1. 把 qoder 的 CLI 参数翻译/过滤成 claude 参数；
2. 拦截并应答 SDK 发来的 `control_request` 帧；
3. 把 claude 的 stream-json 事件改写为 SDK 期望的事件后回流；
4. 维护成本台账。

## 输入 / 输出

- **启动**：`node src/bridge-shim.mjs <qoder-cli-args...>`（SDK 检测到 `.mjs` 路径时自动以 node 执行；cwd 由 SDK 传入）。
- **stdin（JSONL）**：`control_request` 帧 + `user` 消息（`{type:"user",session_id,message:{...}}`）。
- **stdout（JSONL）**：`system/init`、`assistant`、`user`、`result`、`control_response` 等事件，最后正常退出（退出码 0；SDK 视 41 为认证过期，勿误用）。
- **stderr**：日志（SDK 会记录并回传 app）。

## 行为契约

### 1. 参数翻译（白名单驱动，见 `src/bridge-shim.mjs` 的 `VALUE_ARGS`/`FLAG_ARGS`）

**基础帧（硬编码注入）**：`-p --output-format stream-json --input-format stream-json --verbose`

**透传有值参数**（`VALUE_ARGS` 集合）：

| 参数 | 备注 |
|---|---|
| `--session-id` / `--resume` | 直通 claude |
| `--add-dir` / `--agent` / `--images` / `--include` / `--plugin-dir` | 透传 |
| `--allowed-mcp-server-names` / `--system-prompt` / `--append-system-prompt` | 透传 |
| `--max-budget-usd` / `--max-output-tokens` / `--context-window` | 透传 |
| `--output-format` / `--input-format` / `--model` | 透传（但 `--output-format stream-json` 会触发追加 `--verbose`） |
| `--mcp-config` | 透传（qw-builtin 网关必需）；`--strict-mcp-config` 丢弃（让主人既有 MCP 共存） |

**透传无值参数**（`FLAG_ARGS` 集合）：`--print --bare --continue --fork-session --include-partial-messages --debug --no-session-persistence --strict-mcp-config --yolo`

**丢弃参数**（不在白名单）：

- `--setting-sources` / `--settings` / `--tools` / `--allowed-tools` / `--disallowed-tools`：claude 默认加载 user/project/local + 全套工具
- `--permission-mode default`：不传（用 claude 默认）；`bypassPermissions`/`accept_edits`/`dont_ask`/`auto`/`plan` 按 claude 词汇表归一后透传（`PM_MAP`）
- `--caller-version --ide-type --session-mirror --porcelain --keep-data --workdir --org-id --email --extensions --disable-builtin-skills --permission-prompt-tool --max-turns`：过滤
- 未知参数：丢弃并记日志（保守原则）

**模型**：app 传的 `qwen-*` 模型名丢弃；仅当 `QODER_BRIDGE_MODEL` 环境变量设置时才显式传 `--model`。

### 2. control_request 应答表（SDK → shim，stdin 拦截）

仅实现 app 实测会用到的请求，其余归入 default（成功 + 空对象）。

| 请求 | 响应策略 |
|---|---|
| `initialize` | `{commands:[], agents:[], skills:[], output_style:"default", available_output_styles:[], models:[], account:{}, capabilities:[interrupt_receipt_v1, interrupt_cancel_queued_v1, msg_lifecycle_v1, session_rewind_v1, background_tasks_v1], pid}` |
| `get_models` | `{models:[{value:"claude-bridge", displayName:"Claude", description:"使用强大的 Claude Code 代理后端", modelId:"claude-bridge", source:"system", isDefault:true}]}` |
| `get_context_usage` | `{categories:[{name:"User Messages",tokens:0,color:"#3b82f6"},{name:"Assistant Messages",tokens:0,color:"#22c55e"},{name:"Thinking",tokens:0,color:"#8b5cf6"}], totalTokens:0, maxTokens:0, rawMaxTokens:0, percentage:0, gridRows:[]}` |
| `generate_session_title` | 用 `req.description` 或 `lastUserText` 截断 20 字生成 `{title}` |
| `interrupt` | SIGTERM kill 当前 claude 子进程，返回 `{still_queued:[]}` |
| 其他 | 记日志 `CTRL-UNHANDLED`，返回 `{}`（成功空值；绝不把 control_request 原文写入 claude stdin） |

应答格式严格按 SDK 约定：`{"type":"control_response","response":{"subtype":"success","request_id":<原id>,"response":<值>}}`；错误用 `{"subtype":"error","error":...,"code":...}`。

### 3. 事件改写（claude stdout → SDK）

| claude 事件 | 改写 |
|---|---|
| `system/init` | 注入 `protocol_version:"1.2.0"`；`tools[]` 中做 `Task→Agent`/`TodoWrite→TaskCreate` 工具名映射；其余字段（cwd/session_id/capabilities/skills/agents/...）透传 |
| `assistant` 消息 | `message.content[]` 中 `tool_use.name`：`Task→Agent`、`TodoWrite→TaskCreate`；其余工具名不改（app 按未知工具渲染通用卡片） |
| `result` | 透传；**同时记入成本台账** |
| 其他 | 透传（JSON 解析失败的行也原样透传） |

### 4. 内部查询（省钱优化）

检测条件（任一命中）：`--bare` 标志 / `--disallowed-tools` 值为 `*` / `--tools` 值为空串。

命中后进入 `runInternal()` 模式：本地应答 `initialize` + `get_models` 等 control_request，不 spawn claude，等 stdin EOF 后 exit 0。节省 70%+ 的无效 token 消耗。

### 5. 会话映射

- app 传 `--session-id <uuid>`：原样传给 claude（claude 接受任意合法 UUID）。
- app 传 `--resume <id>`：原样传 `--resume <id>`（假定 app 传的都是合法 UUID）。
- 暂无 `session-map.json` 映射文件（待联调验证是否需要）。

### 6. cwd 与工作区

- **继承 SDK 传入的 cwd**（app 工作区目录，如 `~\.qwenworkcn\workspace\<chatId>`），让 claude 直接落在千问办公的工作流路径上。
- 文件操作权限遵循主人既有 claude 权限配置（`~/.claude/settings.json` 的 allow 列表）。
- 如需操作其他目录，通过 `--add-dir` 或 claude 既有权限配置放行。

### 7. 成本台账

每次 `result` 事件：追加一行 JSON 到 `~/.qwenwork-bridge/ledger.jsonl`：
`{ts, sessionId, model, total_cost_usd, num_turns, duration_ms, is_error, result_preview}`（`result_preview` 为 `msg.result` 截断 120 字）。

## 约束

- **不修改 app.asar / 不修改 SDK**；唯一外部改动是环境变量 `QODER_CLI_PATH` + `QODERCLI_PATH`（跨平台注册）。
- 保持协议保守：无法翻译的帧宁可丢弃/报成功，不可把 control_request 原文写入 claude stdin。
- 退出码：正常 0；claude 异常退出时同样以非 0 退出并输出 stderr 摘要（SDK 会包装为 QoderCliProcessError 上报）。
- 信号透杀：shim 收到 SIGTERM/SIGINT 时必须 kill claude 子进程，避免孤儿进程。
- 兼容性：进程可能被并发 spawn（主对话 + 内部查询），shim 无状态或按 `--session-id` 分文件存储。
- **跨平台**：
  - Windows: `QODER_CLI_PATH` 指向 `.mjs` 文件（SDK 自动识别并用 node 执行）。
  - macOS: `QODER_CLI_PATH` 指向 `.sh` wrapper（绕过 SDK PATH 限制，wrapper 内部探测 node 绝对路径）。

## 实现与测试

### 文件清单

| 文件 | 职责 |
|---|---|
| `src/bridge-shim.mjs` | 核心翻译层（参数翻译 + 控制协议应答 + 事件改写 + 台账） |
| `src/bridge-shim-wrapper.sh` | macOS shell wrapper（绕过 SDK PATH 限制，探测 node 绝对路径） |
| `src/bridge-shim.test.mjs` | 自动化测试（模拟 SDK 调用 shim，验证内部查询 + 真实会话多轮） |
| `src/index.mjs` | `pnpm apply`/`pnpm unapply`：注册/撤销 `QODER_CLI_PATH` + `QODERCLI_PATH` 两个环境变量（跨平台：Windows 注册表 + macOS launchctl） |

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `QODER_BRIDGE_CLAUDE` | 覆盖 `claude` 可执行文件路径 | Windows: `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`；macOS: 自动探测 npm prefix 或常见路径 |
| `QODER_BRIDGE_MODEL` | 强制指定 claude 模型别名 | 不设置（由 claude 自行选择） |
| `QODER_BRIDGE_NODE` | macOS 专用：覆盖 node 可执行文件路径 | 自动探测 `/opt/homebrew/bin/node` 等常见路径 |
| `CLAUDE_CODE_ENTRYPOINT` | shim 传给 claude 的标记（内部） | `qwenwork-bridge` |

### 运行日志

每次 shim 启动在 `src/logs/bridge-<pid>-<ts>.log` 落盘（已 .gitignore）：记录 ARGV、ENV（QODER*）、CWD、MODE（internal/real session）、CTRL-UNHANDLED、EXIT。

### 实现步骤（已完成）

1. ✅ **Spy 阶段**：写只记录不改写的 `spy.mjs`，设 `QODER_CLI_PATH=spy.mjs`，重启千问办公走完整任务，产出真实协议样本（`src/logs/spy-*.log`）。
2. ✅ 依据样本校准 spec 的应答表与改写表。
3. ✅ 实现 `src/bridge-shim.mjs`。
4. ✅ 冒烟测试：`src/bridge-shim.test.mjs` 模拟 SDK 验证事件流。
5. ✅ **macOS 平台适配**：新增 `bridge-shim-wrapper.sh`，解决 SDK PATH 限制导致 spawn 失败的问题。
6. 待办：联调（设 `QODER_CLI_PATH` → 重启 app → 全流程验证）。**已部分通过**（单轮会话成功），多轮/技能/回归待补。

## 验收标准

- [x] 自动化测试通过（`node src/bridge-shim.test.mjs`：内部查询 + 真实会话多轮）。
- [x] 千问办公内发送任务：回复流式渲染，无报错弹窗（2026-08-21 14:18 首条 ledger `is_error: false` 会话落地，cost $0.0477，18063ms）。
- [ ] 多轮对话上下文连续（第二轮的 `--resume` 命中同一 claude 会话）。
- [ ] 子代理调用在 UI 显示为 Agent 卡片（Task→Agent 映射生效）。
- [ ] Bash/Edit/Write 等文件操作在 app 工作区可见可查。
- [ ] 主人既有 claude 配置生效（权限允许列表、MCP、skills、CLAUDE.md）。
- [ ] 千问内置 docx/pptx/xlsx/pdf skills 复制到 `~/.claude/skills/` 后可由 claude 调用（Skill 工具触发）。
- [ ] 台账文件 `~/.qwenwork-bridge/ledger.jsonl` 逐次记录 `total_cost_usd`。
- [ ] `pnpm unapply` 后 app 恢复原引擎（回退开关有效）。
- [ ] 千问办公更新到新版本后挂点仍生效（回归检查项）。

## 已知降级（验收时向用户明示）

- 图像生成（ImageGen/ImageSearch）不可用。
- 千问 UI 的「额度/用量」面板无 qoder 数据（由 shim 台账兜底）。
- claude 专属工具（Cron/Workflow/DesignSync/SendMessage 等）在 UI 中显示为通用工具卡片。
- 权限弹窗体验改为 claude 侧配置驱动（shim 对 `can_use_tool` 等请求返回空成功）。

## 实测校准记录（2026-08-21，Spy 阶段样本）

样本归档：`src/logs/spy-*.log`。已用实测校准的要点：

1. **查询分两类**（shim 已按此分治）：
   - 内部查询：`--bare`（模型列表）或 `--disallowed-tools *`（闲置建议）；SDK 传 `--disallowed-tools *` 时同时带 `--tools` 全列表。特征命中即自答。
   - 真实会话：带 `--session-id <uuid>` + `--mcp-config`（qw-builtin 网关）+ cwd=`~\.qwenworkcn\workspace\<chatId>`。
2. **多轮=同进程常驻**：两轮对话 SPAWN 仅 1 次；SDK 不关闭 stdin，CLI 持续处理到 EOF。claude `-p --input-format stream-json` 原生同构（实测 MULTITURN_OK：同 session 两轮 result、上下文连续）。
3. **`initialize` 应答实测形状**：`{commands:[],agents:[],skills:[],output_style:"default",available_output_styles:[],models:[],account:{},capabilities:[interrupt_receipt_v1,interrupt_cancel_queued_v1,msg_lifecycle_v1,session_rewind_v1,background_tasks_v1],pid}`。
4. **`get_models` 应答**：`{models:[{value,displayName,description,modelId,source,isDefault,...}]}`（真实值为 qwork-advanced/qwork-lite 等，带 Credit 描述）。
5. **`can_use_tool` 请求**：`{subtype:"can_use_tool",tool_name,tool_use_id("call_00_..."格式),display_name,description,input}`——app 侧自动放行；claude 不发此类请求（权限由 claude 配置接管）。
6. **CLI→SDK 方向**：`get_model_policy`（app 经 SDK 的 resolveModel 回调应答）、`fetch_job_token`（SDK 应答 JWT）。claude 不发，SDK 不强制。
7. **hooks**：app 经 initialize 传入 hook 定义（`SessionStart/PreToolUse` + `hookCallbackIds`），CLI 触发时走 `hook_callback` control 请求。claude 用自身 hooks 系统，shim 不实现该通道。
8. **user 消息帧**：`{type:"user",session_id,message:{role:"user",content:[{type:"text",text}]}}`；第二轮消息不含历史（上下文靠进程内会话）；可能带 `<system-reminder>`（awareness 记忆 diff），属文本内容自然透传。
9. **`--session-id` 必须合法 UUID**：claude 校验格式（实测非 UUID 报错退出码 1）。
10. **`--mcp-config` 必须透传**：qw-builtin 是 app 本地工具网关（127.0.0.1 端口 + x-api-key）；**丢弃 `--strict-mcp-config`** 让主人既有 MCP（钉钉 DWS 等）共存。
11. **`--settings` 丢弃**（outputStyle/aiCodeStatistics 非 claude 字段）；`--setting-sources` 丢弃（claude 默认 user/project/local）；`--tools` 丢弃（claude 默认全套工具，含主人特色工具）；`--permission-mode default`→不传，`bypassPermissions`→透传。
12. **`--verbose` 追加**：claude 2.x 要求（实测报错「requires --verbose」）。
13. **spy 实验教训**：SDK 对 CLI 的退出码 0/41 语义敏感；spy/shim 被杀（SIGTERM）时需透杀子进程，否则 qoderclicn/claude 变孤儿。
14. **台账**：`~/.qwenwork-bridge/ledger.jsonl` 已实测落盘（`total_cost_usd/num_turns/duration_ms/is_error/result_preview`）。

## 联调校准记录（2026-08-21，真实千问办公联调）

1. **双环境变量必须同时注册**：首次只注册 `QODER_CLI_PATH`（有下划线）时 shim 完全没被调用（`src/logs/` 目录为空）。解包 SDK 发现 App 壳层读 `QODER_CLI_PATH`，SDK 内核 `resolveExecutable()` 读 `QODERCLI_PATH`（无下划线）。两者一并注册后 shim 才被调用（详见 DECISIONS.md D6）。
2. **`binaryPathComputed` 缓存**：App 启动时计算一次 CLI 路径后缓存，**必须杀干净所有 QwenWorkCN 进程完全重启**才能重读环境变量（DECISIONS.md D6 的更准确理解）。
3. **claude 必须绝对路径**：shim 首次 spawn 时日志报 `spawn claude ENOENT`，千问办公进程的 PATH 不含 npm 全局 bin 目录。改为绝对路径（Windows: `%APPDATA%\npm\...\claude.exe`；macOS: 自动探测）后成功（详见 DECISIONS.md D7）。
4. **macOS PATH 限制**：SDK 的 `buildQoderAgentSdkRuntimeEnv` 把 PATH 硬编码为 `/usr/bin:/bin:/usr/sbin:/sbin`，不含 `/opt/homebrew/bin`，导致 `.mjs` 文件 spawn 时报 "executable not found"。新增 shell wrapper 探测 node 绝对路径后解决（详见 DECISIONS.md D8）。
5. **首条成功会话**：sessionId `bfce2bb1-862a-4141-9229-3cca29fe6d6f`，cost $0.047655，1 turn，18063ms，`is_error: false`。

### 已通过的自测（src/bridge-shim.test.mjs）

- 内部查询：initialize+get_models 应答、exit 0 ✓
- 真实会话两轮：initialize 应答 → user×2 → result×2（同 session）→ exit 0，init 注入 protocol_version ✓
