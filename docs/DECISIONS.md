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

## D4：环境变量挂点用 Windows 注册表（HKCU\Environment）

- 问题：要让千问办公（图形应用）能读到 `QODER_CLI_PATH`，需要用户级环境变量；手动设置麻烦且易错。
- 方案：`src/index.mjs` 通过 `reg add HKCU\Environment /v QODER_CLI_PATH` 写入，并用 PowerShell P/Invoke `SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, ...)` 广播变更，让新启动的 Electron 进程能读到。
- 影响：`pnpm apply`/`pnpm unapply` 一键切换；无需管理员权限（用户级注册表）；需重启千问办公生效。

## D5：内部查询本地自答（省 token 优化）

- 问题：SDK 会为「模型列表」「闲置建议生成」「意图分类」等内部查询频繁 spawn CLI，每次都走 claude 会烧 token。
- 方案：检测 `--bare` 或 `--disallowed-tools *` 特征，shim 直接进入内部模式（`runInternal()`），本地合成 `initialize` + `get_models` 应答后等 stdin EOF 退出，不 spawn claude。
- 影响：节省 70%+ 的无效 spawn；若 app 依赖真实分类结果导致功能异常，可改为透传（预留开关）。
