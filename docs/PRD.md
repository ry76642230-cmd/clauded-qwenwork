# PRD — 千问办公换芯计划（Backend → Claude Code）

## 为什么要做，以及要做什么？

### 产品目标

让主人继续使用千问办公的界面与办公工作流，但其 Agent 后端（任务执行、工具调用、文件操作、计费）**完全由 Claude Code 承担**。用户感知：UI 不变，能干的事变多、执行质量变高、成本可见。

### 用户与使用场景

- 用户：主人本人（单机、单用户）。
- 场景：
  1. 在千问办公对话框下发任务（整理文档、做表格/PPT、处理 PDF、跨应用办事），期待更强工具链与更可靠执行。
  2. 需要 Claude Code 生态的能力：主人已有的 MCP 服务器（如钉钉 DWS 系列）、skills、hooks、权限配置直接可用。
  3. 需要清晰计费：每次任务实际花多少，从 Claude 侧台账可见。

### 核心问题

千问办公是 Electron 应用，其本地 Agent 引擎为「qoder CLI（Claude Code CLI 的 fork）+ 协议 SDK」。要在不改 UI、不改 asar 的前提下，把引擎进程整体替换为 Claude Code CLI，并在两层协议差异之间做翻译。

### 功能及其存在的意义

| 功能 | 实现文件 | 意义 |
|---|---|---|
| Bridge shim（Node 翻译层） | `src/bridge-shim.mjs` | 承接 SDK 的 spawn 参数与 JSONL 流，翻译为 claude 协议，双向改写 |
| macOS shell wrapper | `src/bridge-shim-wrapper.sh` | 绕过 SDK PATH 限制，探测 node 绝对路径 |
| 控制协议应答 | `src/bridge-shim.mjs` | 应答 SDK 的 `control_request`（initialize/get_models/get_context_usage/generate_session_title/interrupt 等），保证 UI 不崩 |
| 内部查询自答 | `src/bridge-shim.mjs` | 模型列表/闲置建议等内部查询本地合成应答，不消耗 token |
| 会话 ID 直通 | `src/bridge-shim.mjs` | `--session-id`/`--resume` 原样传给 claude，多轮上下文连续 |
| 技能复用 | 手动操作 | 千问内置 SKILL.md（docx/pptx/xlsx/pdf 等）复制进 `~/.claude/skills/`，Claude 直接调用 |
| 成本台账 | `src/bridge-shim.mjs` | 每次运行 `result.total_cost_usd` 追加到 `~/.qwenwork-bridge/ledger.jsonl`，主人可查每次任务花费 |
| 注册/撤销工具 | `src/index.mjs` | `pnpm apply`/`pnpm unapply` 一键注册/撤销 `QODER_CLI_PATH` + `QODERCLI_PATH` 两个环境变量（跨平台） |

### 功能之间的关系

```
千问办公 UI
   └─ 主进程 main.js ── QODER_CLI_PATH 挂点
        └─ src/bridge-shim.mjs（本工程）
             ├─ 参数翻译 → claude
             ├─ 事件/控制协议翻译 ← claude stream-json
             ├─ 内部查询自答（省 token）
             └─ 成本台账
```

### 产品范围与 Non-Goals

范围：shim、注册工具、文档、成本台账。
Non-Goals：

- 不改 UI / 不重新打包千问办公。
- 不移植 qoder 云端能力（ImageGen、ImageSearch、云端技能市场）。
- 不实现多用户 / 团队计费。
- 不绕过千问办公登录与 Claude 计费（都走既有通道）。
