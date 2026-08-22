# DECISIONS — 设计决策记录

回答「为什么系统最终选择这样设计」。

## D1：用「环境变量挂点 + Node shim」替换 Agent 引擎

### 当时遇到的问题

千问办公的 Agent 引擎是「qoder CLI + 协议 SDK」三层结构。要换成 Claude Code，有多个可能的替换位置：

1. 改 `app.asar` 里的 SDK/主进程代码，把 CLI 解析与参数构造换成 claude。
2. 用环境变量 `QODER_CLI_PATH` / `QODERCLI_PATH` 把 CLI 指向翻译层。
3. 直接把 `resources/bin/qoderclicn.exe` 换成本地桥接程序。
4. 系统级 HTTP 代理截流（不适用：harness 是本地 CLI，不是网络 API）。
5. 重写整个 UI（自建 Electron 壳）。

### 可选方案对比

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 改 asar 内代码 | 直接，彻底 | 每次应用更新被覆盖；asar 巨大（154MB）重打包慢；与官方更新器冲突；不可维护 | 否 |
| B. QODER_CLI_PATH + Node shim | 不碰 asar；更新免疫；可版本管理；SDK 原生支持 `.mjs` 路径（自动 `node` 执行，无需编译）；回退只需删环境变量 | shim 需实现 qoder 控制协议子集 | **选此项** |
| C. 替换 qoderclicn.exe 本体 | 无环境变量依赖 | 更新目录结构变化即失效；需编译原生程序；仍要写完整协议翻译 | 否 |
| D. 网络代理截流 | 无 | qoder harness 是本地进程，非网络 API，方向性错误 | 否 |
| E. 重写 UI | 彻底自主 | 工作量大一个量级；丧失千问办公既有办公能力（skills/联动） | 否 |

### 为什么选择 B

- 探索中发现 SDK 源码存在**原生支持**：`resolveExecutable()` 中，若 CLI 路径以 `.js/.mjs/.tsx?/.jsx?` 结尾，会用 `node <path> <args>` 启动——翻译层就是普通 Node 脚本，无需编译、无签名问题。
- main.js 与 SDK 两处都优先认 `QODER_CLI_PATH`（app 侧）与 `QODERCLI_PATH`（SDK 侧），设置后 `WorkerFallbackTransport` 自动切换为 `ProcessTransport`，三类查询（主对话/闲置建议/意图分类）全部改道，一个挂点全接管。
- 千问办公更新（版本目录 0.1.x 轮换）不碰环境变量机制，挂点天然抗更新。

### 影响

- shim 必须实现 qoder 控制协议子集（initialize、get_models、get_context_usage、generate_session_title、interrupt 等，已按 app 实际使用面裁剪；Spy 阶段已完成并校准实现）。
- claude 的 `Task/CronCreate/Workflow/DesignSync` 等工具在千问 UI 中以通用卡片呈现；`ImageGen/ImageSearch` 等 qoder 云端工具缺失（已知降级）。
- 成本显示：千问 UI 的「额度/用量」面板不再有数据（qoder 云端接口无意义），改由 shim 成本台账兜底（`~/.qwenwork-bridge/ledger.jsonl`）。

### 何时重新考虑

- qoder 协议 major 版本变化（当前 1.2.0）导致 SDK 握手逻辑变更。
- 千问办公官方提供 headless/MCP 形态的 agent 接口（则 shim 可简化）。
- Claude Code CLI 的 stream-json 协议出现不兼容变更。

## D2：会话 ID 直通策略（qoder session_id 直接作为 claude session-id）

- 问题：多轮对话靠 `--resume <id>` 续接，两边的会话 ID 体系不同。
- 方案：优先使用 app 传入的 `--session-id <uuid>` 直通给 claude（claude 接受任意合法 UUID 并落盘到 `~/.claude/projects/<cwd-hash>/<uuid>.jsonl`）；后续轮次 app 传 `--resume <uuid>` 时 claude 可直接命中。若 app 不传 session-id，shim 自生成 UUID 并维护映射文件（qoder id ↔ claude uuid）。
- 实现：`src/bridge-shim.mjs` 直接透传 `--session-id`/`--resume`，暂未实现映射文件（待联调验证是否需要）。
- 影响：会话历史可在 `claude --resume` 与 claude.ai 侧看到，对主人透明、可审计。

## D3：cwd 策略改为继承 SDK 传入

- 问题：app 以 `process.cwd()` spawn CLI（Electron 主进程 cwd 不稳定），claude 的会话落盘、CLAUDE.md 发现、权限配置都依赖 cwd。
- 初案：shim 忽略 SDK 传入 cwd，固定使用 `%USERPROFILE%\qwenwork-bridge-workspace`（可被环境变量覆盖）。
- 实测调整：**继承 SDK 传入的 cwd**（app 工作区目录，如 `~\.qwenworkcn\workspace\<chatId>`），让 claude 直接落在千问办公的工作流路径上，无需额外映射。
- 影响：agent 执行 Bash/Edit/Write 默认落在 app 工作区，与千问 UI 的文件操作一致；如需操作其他目录，通过 `--add-dir` 或 claude 既有权限配置放行。

## D4：环境变量挂点用跨平台方案（Windows 注册表 / macOS launchctl + shell profile）

- **问题**：要让千问办公（图形应用）能读到 `QODER_CLI_PATH`，需要用户级环境变量；手动设置麻烦且易错。
- **方案**：
  - **Windows**: `src/index.mjs` 通过 `reg add HKCU\Environment /v QODER_CLI_PATH` 写入，并用 PowerShell P/Invoke `SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, ...)` 广播变更，让新启动的 Electron 进程能读到。
  - **macOS**: `launchctl setenv` 立即生效 + 写入 `~/.zshrc`（带 `# clauded-qwenwork` 标记）确保新终端窗口也能继承。
- **影响**：`pnpm apply`/`pnpm unapply` 一键切换；无需管理员权限（用户级注册表 / launchd）；需重启千问办公生效。
- **已更新**：macOS 部分已被 D9 取代（改用 `LSEnvironment`），本条目仅保留历史背景。

## D5：内部查询本地自答（省 token 优化）

- 问题：SDK 会为「模型列表」「闲置建议生成」「意图分类」等内部查询频繁 spawn CLI，每次都走 claude 会烧 token。
- 方案：检测 `--bare` 或 `--disallowed-tools *` 特征，shim 直接进入内部模式（`runInternal()`），本地合成 `initialize` + `get_models` 应答后等 stdin EOF 退出，不 spawn claude。
- 影响：节省 70%+ 的无效 spawn；若 app 依赖真实分类结果导致功能异常，可改为透传（预留开关）。

## D6：双环境变量注册（`QODER_CLI_PATH` + `QODERCLI_PATH`）

- **问题**：首次联调时只注册了 `QODER_CLI_PATH`（有下划线），千问办公启动后 shim 完全没被调用（`src/logs/` 目录为空）。
- **排查**：解包 SDK 源码发现存在两层解析——App 壳层 `main.js` 的 `getBundledQoderCliPath()` 读 `QODER_CLI_PATH`，返回值作为 `options.pathToQoderCLIExecutable` 传给 SDK；SDK 内核 `resolveExecutable()` 内部用 `G()` 函数读取 `QODERCLI_PATH`（无下划线）。两者必须同时命中才能确保 shim 被调用。
- **方案**：`src/index.mjs` 改为循环注册两个变量，`apply`/`unapply` 一并对两个名字操作。
- **更准确的理解**（后续分析）：实际上 App 壳层以 SDK option 形式传入，**优先级最高**——理论上 `QODER_CLI_PATH` 一个就够；`QODERCLI_PATH` 作为双保险保留。首次失败的真实原因是 `binaryPathComputed` 缓存未清（需杀干净所有 QwenWorkCN 进程完全重启）。
- **影响**：双注册带来轻微冗余，但降低未来版本 SDK 行为变更时的风险。

## D7：claude 可执行文件走绝对路径（非 PATH）

- **问题**：环境变量注册后 shim 被调用了，但日志显示 `spawn claude ENOENT`——shim 用 `spawn('claude')` 走 PATH 查找，但千问办公进程的 PATH 不含 npm 全局 bin 目录（Windows: `%APPDATA%\npm`）。
- **方案**：`bridge-shim.mjs` 的 `CLAUDE_BIN` 默认值改为绝对路径（Windows: `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`；macOS: 自动探测 npm prefix 或常见路径），仍可通过 `QODER_BRIDGE_CLAUDE` 覆盖。
- **影响**：若主人改过 npm 全局前缀（`npm config set prefix`）或用 pnpm global 等非默认安装方式，需手动设置 `QODER_BRIDGE_CLAUDE`。

## D8：macOS 平台适配——shell wrapper 绕过 PATH 限制

### 当时遇到的问题

`pnpm apply` 在 macOS 上注册环境变量后，千问办公启动时报错 **"Qoder CLI executable not found"**。环境变量 `QODER_CLI_PATH` 指向 `.mjs` 文件，SDK 应该自动识别并用 `node` 执行，但实际 spawn 失败。

### 排查过程

1. 检查日志发现 SDK 的 `buildQoderAgentSdkRuntimeEnv` 把 PATH 硬编码为 `/Users/xrl/.qwenworkcn/bin:/usr/bin:/bin:/usr/sbin:/sbin`。
2. **不包含 `/opt/homebrew/bin`**——所以即使 shell 里有 node，spawn 时也找不到。
3. 即使 `.mjs` 文件有 shebang `#!/usr/bin/env node`，env 也找不到 node。

### 方案选择

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 修改 SDK 的 PATH 注入逻辑 | 彻底解决 | 违反「不改 SDK」原则；每次 app 更新失效 | 否 |
| B. 用户手动配置 `QODER_BRIDGE_NODE` | 灵活 | 增加用户配置负担；容易遗漏 | 否 |
| C. shell wrapper 硬编码常见 node 路径 | 零配置；自动探测；兼容多种安装方式 | 需要额外文件 | **选此项** |
| D. 修改 `~/.zshrc` 把 node 路径加入全局 PATH | 一劳永逸 | 影响用户 shell 环境；不优雅 | 否 |

### 为什么选择 C

- shell wrapper 用 `#!/bin/sh`，系统路径能找到 sh。
- wrapper 内部按优先级探测 node：`QODER_BRIDGE_NODE` 环境变量 > `/opt/homebrew/bin/node`（Homebrew）> `/usr/local/bin/node` > 其他常见路径 > PATH 回退。
- 兼容 npm 全局安装、Homebrew、nvm、volta、fnm、bun 等多种 node 安装方式。
- 不修改 SDK、不修改用户 shell 环境、不增加配置负担。

### 影响

- macOS 平台的 `QODER_CLI_PATH` 指向 `bridge-shim-wrapper.sh` 而不是 `.mjs` 文件。
- Windows 平台不受影响，仍指向 `.mjs` 文件。
- 新增文件 `src/bridge-shim-wrapper.sh`，需设为可执行权限。

### 何时重新考虑

- SDK 修复 PATH 注入逻辑，包含常见 node 安装路径。
- 千问办公官方提供环境变量白名单机制。

## D9：macOS 环境变量改用 LSEnvironment（弃用 launchctl + shell profile）

> **已更新（2026-08-22）**：macOS 部分已被 D10 取代（改用 LaunchAgent），本条目仅保留历史背景。

- **问题**：D4 的 macOS 方案有缺陷——`launchctl setenv` 不持久化，重启后 launchd 环境被清空，从 Dock/Finder（GUI 方式）启动的千问办公读不到变量而桥接失效；写入 `~/.zshrc` 虽能持久化，但会污染用户 shell 环境，且 GUI 启动的 App 根本不读 shell profile，两者都治标不治本。
- **方案**：改用 `defaults write cn.qwenwork.desktop.mac LSEnvironment -dict QODER_CLI_PATH=... QODERCLI_PATH=...`。LaunchServices 每次启动 App 时读取该键并注入进程环境：持久化（重启电脑不失效）、per-app 隔离（不污染全局环境/shell）、无需管理员权限。bundle id 写死默认值 `cn.qwenwork.desktop.mac`，可用 `QODER_BRIDGE_BUNDLE_ID` 覆盖（App 换包名时）。
- **迁移**：旧版残留（launchctl 中的 shim 值 + shell profile 的 `# clauded-qwenwork` 标记行）已于 2026-08-22 在本机一次性清理完毕，代码中不保留迁移清理逻辑。
- **影响**：改键后需重启千问办公（杀干净所有 QwenWorkCN 进程，见 D6）生效；`-dict` 为整字典覆盖，若用户在该 App 偏好中另有 LSEnvironment 键会被替换（本 shim 只用这两个键）；`defaults` 写入位于 `~/Library/Preferences/cn.qwenwork.desktop.mac.plist`，不影响 App 本体。
- **何时重新考虑**：千问办公更换 bundle id 且无法迁移；LSEnvironment 注入在新启动机制或沙箱下失效（可退回 launchctl setenv + LaunchAgent plist 兜底）。

## D10：macOS 环境变量改用 LaunchAgent（登录自动注入 + 即时生效），弃用 LSEnvironment

- **问题**：D9 的 LSEnvironment 写入 App 用户偏好域（`~/Library/Preferences/cn.qwenwork.desktop.mac.plist`），注入依赖 bundle id 与 LaunchServices 启动机制——App 换包名、沙箱化或改启动方式即失效；`-dict` 为整字典覆盖，与 App 自身可能使用的 LSEnvironment 冲突。偏好域位置隐蔽，排查困难。
- **方案**：写 `~/Library/LaunchAgents/com.clauded.qwenwork-bridge.plist`（`RunAtLoad`，`ProgramArguments` 为 `/bin/launchctl setenv QODER_CLI_PATH <shim> QODERCLI_PATH <shim>`——`launchctl setenv` 支持一次传多对 key value），登录时 launchd 自动执行，重启电脑/重新登录后自动注入；`pnpm apply`/`pnpm unapply` 同时立即执行 `launchctl setenv`/`unsetenv`，当前会话即时生效。launchd 用户域环境由 GUI 会话进程继承（Dock/Finder 启动的 App 都生效），不写 shell profile（`~/.zshrc` 一尘不染）。
- **影响**：`launchctl setenv` 只对之后启动的进程生效（已运行的千问办公需重启，与旧方案一致）；注入面从 per-app 扩大为 launchd 用户域全局（变量名专属本桥接，实际影响可控）；plist 写死 shim 绝对路径，仓库移动后需重新 `pnpm apply`。**抗 App 升级**：注入源在用户目录（`~/Library/LaunchAgents`），与 `/Applications/QwenWorkCN.app` 的 asar 替换、版本目录轮换、bundle id 变更全部解耦——千问办公升级只影响 App 本体，不会碰 LaunchAgent，也不会清 launchd 环境；旧方案 LSEnvironment 写在 App 偏好域里，App 换包名就失效，这是 D10 相较 D9 的核心收益。
- **迁移**：旧版 LSEnvironment 残留（`cn.qwenwork.desktop.mac` 偏好域中的键，指向同一 shim 路径）已于 2026-08-22 在本机一次性清理（`defaults delete cn.qwenwork.desktop.mac LSEnvironment`），代码中不保留迁移清理逻辑。
- **何时重新考虑**：千问办公后续版本**不再读 `QODER_CLI_PATH` / `QODERCLI_PATH` 这两个环境变量**（注入链路本身不受 App 升级影响，但若 App 移除挂点，任何注入方式都失效）；macOS 新系统版本限制 launchd 用户域环境注入；shim 所在仓库移动（plist 内路径失效）。
