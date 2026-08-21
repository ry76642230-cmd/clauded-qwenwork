# ARCHITECTURE — 千问办公内部结构解剖与换芯架构

回答「系统整体是如何组织的」。

## 一、现状解剖（2026-08-21 实测）

### 1. 安装布局

```
C:\Program Files\QwenWorkCN\
├── Launcher.exe          # 启动器（多版本管理）
├── Updater.exe           # 更新器（Squirrel 风格）
├── updater.cfg           # 当前版本 0.1.8-26081406
└── 0.1.8-26081406\       # 版本目录（历史版本保留：0.1.6/0.1.7）
    ├── QwenWorkCN.exe    # Electron 主程序（204MB）
    ├── resources\
    │   ├── app.asar      # 154MB 应用代码（已解包分析）
    │   ├── app.asar.unpacked\node_modules\   # 原生模块（117MB）
    │   ├── bin\          # qoderclicn.exe / qoderclicn-legacy.exe / qwenwork.exe / 辅助 exe
    │   ├── skills\       # 内置技能：create-skill docx find-skills media-generation pdf
    │   │                 #   plugin-creator pptx qw-pages qw-pages-supabase
    │   │                 #   qwenwork-guidance xlsx（均为 SKILL.md + toolkit）
    │   ├── commands\     # create-command.md（slash 命令）
    │   ├── legokits\     # 插件体系（plugin-market-data.json）
    │   ├── vm-boot\      # 沙箱引导
    │   └── ...
```

用户数据：`%APPDATA%\QwenWorkCN\`、`~/.qoder-cn\`（CLI 配置目录，等价 `~/.claude`）、`~/.qwenworkcn\`。

### 2. Agent 引擎三层结构（替换目标）

```
out/main/index.js（Electron 主进程，打包为 out/main/main.js）
   └─ @qoder-ai/qoder-agent-sdk（asar 内 node_modules，npm:@ali/qoder-agent-sdk-next@1.0.20）
        ├─ 默认：WorkerFallbackTransport → 加载 worker runtime 到 worker_threads 进程内执行
        └─ 设置 QODER_CLI_PATH 后：ProcessTransport → spawn 外部 CLI 二进制，JSONL 流通信
             └─ qoderclicn.exe v1.1.18（resources\bin，bun 编译，Claude Code CLI 的 fork）
                  └─ qoder-worker-runtime.obf.mjs（36MB 混淆：agent 循环/工具/skills/MCP/hooks）
```

### 3. 协议面（SDK ↔ CLI）

- 启动参数：`--print --output-format stream-json --input-format stream-json [--include-partial-messages]`，
  叠加 `--model --resume/--continue/--session-id --fork-session --permission-mode --yolo/--dangerously-skip-permissions --allowed-tools --disallowed-tools --tools --mcp-config --strict-mcp-config --allowed-mcp-server-names --settings --setting-sources --plugin-dir --add-dir --max-turns --agent --debug --no-session-persistence --extensions --permission-prompt-tool` 等。
- 双向 JSONL：stdin = control_request 帧 + 用户消息；stdout = `system/init`（握手）、`assistant`、`user`、`result`、`control_response` 等事件。
- 握手：`system/init.protocol_version`（SDK 内置 1.2.0，major 不等即抛错；缺省仅警告）；`capabilities` 数组（如 `background_tasks_v1`）。
- 控制协议（control_request/control_response，qoder 特有，Claude 侧没有）：`initialize`、`get_models`、`get_model_policy`（模型策略，app 端 resolveModel 回调）、`get_context_usage`、`get_usage_info`、`account_info`、`set_permission_mode`、`set_model`、`set_proxy`、`generate_session_title`、`can_use_tool`（权限弹窗，配 `--permission-prompt-tool stdio`）、`hook_callback`、`mcp_*`、`interrupt`、`cancel_async_message`、`stop_task`、`background_tasks` 等。
- 退出码语义：41 = 认证过期（触发 app 重新登录），0 = 正常。

### 4. App 实际使用面（main.js 中确认）

- 三类查询：主对话（query-runtime）、闲置建议生成（`disallowedTools:["*"]`）、内部意图分类（tool-budget / command-intent，`tools:[]`、`maxTurns:1`）——全部经同一 transport 工厂，`QODER_CLI_PATH` 一设全接管。
- 使用的 SDK 能力：`resolveModel`(14)、`stopTask`(12)、`getContextUsage`(5)、`getAvailableModels`(4)、`setPermissionMode`(3)、`generateSessionTitle`(3)、`canUseTool`(1)。
- app 对 result 事件消费：`duration_ms`(59)、`is_error`(17)、`num_turns`(2)；不读 `total_cost_usd`（成本展示来自 qoder 云端用量接口）。
- renderer 按 qoder 工具名渲染卡片：`Agent`(260)、`ImageGen`(5)、`TaskCreate`(3)、`ImageSearch`(2)。

### 5. qoder CLI 与 Claude CLI 差异清单（shim 必读）

| 类别 | 说明 |
|---|---|
| 必加参数 | claude 2.x 要求 `--output-format stream-json` 必须配 `--verbose`（qoder 不需要） |
| qoder 特有参数（需过滤） | `--caller-version --ide-type --session-mirror --porcelain --keep-data --workdir --org-id --email --extensions --disable-builtin-skills --permission-prompt-tool --yolo --max-turns --tools`（空串形式） |
| 直接兼容参数 | `--print --output-format --input-format --include-partial-messages --resume --continue --fork-session --session-id --permission-mode --dangerously-skip-permissions --allowed-tools --disallowed-tools --mcp-config --strict-mcp-config --allowed-mcp-server-names --settings --plugin-dir --add-dir --model --agent --debug --no-session-persistence --bare` |
| 参数值翻译 | `--permission-mode bypassPermissions` ↔ `bypassPermissions`（claude 同词）；app 传 `--setting-sources ""`（空）→ shim 应丢弃，让 claude 加载用户/项目设置；model 名 qwen-* → claude 别名 |
| 工具名映射 | claude `Task`（子代理）→ qoder `Agent`；claude `TodoWrite` → qoder `TaskCreate`；qoder `ImageGen/ImageSearch` 无对应（缺失） |
| 事件差异 | claude `system/init` 无 `protocol_version` → shim 注入 `protocol_version:"1.2.0"`；`capabilities` claude 自带 |
| 控制协议 | claude 完全不认识 control_request 帧 → shim 拦截并应答 |
| 输入格式 | SDK 的 stdin 消息含 `uuid/session_id` 等附加字段，claude 容忍多余字段 |

## 二、换芯后架构（当前实现态）

```
千问办公 UI（不变）
   └─ Electron 主进程（不变，asar 不动）
        └─ qoder-agent-sdk ProcessTransport
             （环境变量 QODER_CLI_PATH + QODERCLI_PATH 双注册触发；App 壳层读前者作为
              options.pathToQoderCLIExecutable 传 SDK，优先级最高；SDK 内核备用读后者）
             └─ node src/bridge-shim.mjs（本工程，唯一改动点）
                  ├─ 参数翻译/过滤 → spawn claude（绝对路径 %APPDATA%\npm\...\claude.exe，
                  │   可被 QODER_BRIDGE_CLAUDE 覆盖）
                  ├─ stdin：control_request 拦截自答；用户消息透传
                  ├─ stdout：claude stream-json 事件改写（init 注入 protocol_version、
                  │   工具名映射）后回流 SDK
                  ├─ 内部查询（--bare / --disallowed-tools *）：本地自答，不 spawn claude
                  ├─ cwd 策略：继承 SDK 传入 cwd（app 工作区目录）
                  └─ 成本台账：每次 result.total_cost_usd 记入 ~/.qwenwork-bridge/ledger.jsonl
```

### 辅助工具

```
src/index.mjs（pnpm apply / pnpm unapply）
   ├─ apply：reg add HKCU\Environment /v QODER_CLI_PATH + QODERCLI_PATH → src/bridge-shim.mjs 绝对路径
   │         + WM_SETTINGCHANGE 广播（PowerShell P/Invoke SendMessageTimeout）
   └─ unapply：reg delete → 广播 → 千问办公重启后恢复原引擎
```

### 数据流（一次任务）

1. 用户在 UI 发送消息 → renderer → IPC → main.js → SDK `query()`。
2. SDK 构造参数 → spawn `node src/bridge-shim.mjs --print --output-format stream-json ...`。
3. shim 解析参数，判定查询类型：
   - **内部查询**（`--bare` / `--disallowed-tools *`）→ 本地自答 `initialize` + `get_models` 后等 stdin EOF 退出，不 spawn claude。
   - **真实会话** → 过滤 qoder 参数、补 `-p --verbose`、透传 `--session-id`/`--resume`/`--mcp-config` 等 → spawn `claude`（优先 `QODER_BRIDGE_CLAUDE`，回退 `PATH`），附带 `CLAUDE_CODE_ENTRYPOINT=qwenwork-bridge`。
4. SDK 经 stdin 先发 `control_request(initialize)` 帧 → shim 拦截，直接回 `control_response`（含 capabilities/commands/agents）。
5. 用户消息帧透传 → claude 处理 → stdout 事件流 → shim 改写（注入 protocol_version、Task→Agent）→ SDK → main.js → renderer 渲染（文本流、工具卡片、结果）。
6. claude 退出码 0 → shim 退出 0 → SDK 正常收尾；`result` 事件携带 `total_cost_usd` 由 shim 记台账。

### 外部系统

- Claude API / 主人已有的 Claude 登录态（计费通道，不变）。
- 千问办公云端（登录、账号、office 能力）仍走原通道，仅 Agent 执行改道。
- 主人已有的 claude 配置（`~/.claude/settings.json`、MCP、skills、hooks、permissions）在 claude 侧自动生效。
- qw-builtin MCP 网关（千问办公本地工具，127.0.0.1 端口）经 `--mcp-config` 透传给 claude。
