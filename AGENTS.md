# AGENTS.md

## 项目是什么

本仓库是「千问办公（QwenWorkCN）Agent 引擎 → Claude Code」替换工程的文档与实现。千问办公是阿里出品的 Electron 应用，内置本地 Agent 引擎（qoder CLI 体系）；本项目的唯一目标是让该引擎的任务执行改道 Claude Code，UI 保持原样。

## Agent 如何理解这个项目

- 核心挂点：**`QODER_CLI_PATH` + `QODERCLI_PATH` 两个环境变量**（用户级，写入 `HKCU\Environment`）。两者必须同时注册——App 壳层 `main.js` 的 `getBundledQoderCliPath()` 读前者，SDK 内核的 `resolveExecutable()` 读后者。设置后，千问办公主进程与 `@qoder-ai/qoder-agent-sdk` 会把所有 Agent 查询改为 spawn 外部 CLI；若该路径以 `.js/.mjs` 结尾，SDK 会用 `node <path>` 执行——因此翻译层是一个 Node 脚本，无需编译。
- 安装/卸载：`pnpm apply` 通过 `reg add` 写入注册表并 `WM_SETTINGCHANGE` 广播；`pnpm unapply` 撤销。详见 `src/index.mjs`。
- 协议面：SDK ↔ CLI 走 JSONL 流（`--output-format stream-json`），其上叠加了 qoder 特有的 `control_request`/`control_response` 控制协议与 `system/init` 握手（`protocol_version`，major 必须为 1）。CLI 是 Claude Code CLI 的 fork，参数与事件结构同构，但存在差异清单（见 `docs/ARCHITECTURE.md` 与 spec）。
- 原始素材：本机 `C:\Program Files\QwenWorkCN\0.1.8-26081406\`（app.asar 已解包分析，可随时重新解包）。

## 代码结构

```
src/
├── bridge-shim.mjs        # 核心翻译层（被 SDK spawn 为 "qoder CLI"）
├── bridge-shim.test.mjs   # 自动化测试（模拟 SDK 调用 shim）
├── index.mjs              # pnpm apply / unapply 注册表工具
└── logs/                  # 运行时日志（.gitignore 已排除）
```

## 项目边界（In Scope）

- 编写 bridge shim（参数翻译、控制协议应答、事件改写、成本台账）。
- 复用千问办公内置 skills（`resources/skills/*/SKILL.md`，格式与 Claude Code 同构）到 `~/.claude/skills/`。
- 编写/维护本项目文档（README / PRD / ARCHITECTURE / DECISIONS / specs）。

## 明确不属于范围（Non-Goals）

- **不改 app.asar**：所有改动通过环境变量挂点与外部 shim 实现；asar 内代码只读分析。
- 不修改千问办公的 UI、登录、云端账号体系（登录仍走千问账号，Claude 侧用主人已有的 Claude 登录态）。
- 不绕过任何付费墙；计费完全走主人已有的 Claude Code 计费通道。
- 不重新实现 Office 能力（docx/pptx/xlsx/pdf 等）：优先复用其 skills 或 Claude 生态技能。
- 不做多用户、不做分发包、不做协议逆向之外的任何灰产用途。
- 图像生成等 qoder 云端专属能力（ImageGen/ImageSearch）不移植，属已知降级。

## 全局规则

- 千问办公每次更新后需重新核对：环境变量挂点是否仍生效（app 版本目录变化不影响环境变量机制，但需抽查）。
- `claude` 可执行文件路径：**千问办公进程的 `PATH` 通常不含 npm 全局目录**，因此 `QODER_BRIDGE_CLAUDE` 默认走绝对路径 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`；也可显式覆盖。
- 排查 shim 是否被调用：看 `src/logs/` 目录是否有新日志文件。
- 所有文档遵循本仓库结构与 CLAUDE.md 的全局文档规范。
