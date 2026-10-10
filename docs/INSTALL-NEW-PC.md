# 新电脑安装（全链路）

把「千问办公 → Claude Code」这条链路在另一台 Windows 电脑上跑起来。

链路（任一环挂掉，千问办公都会报 `API Error: Unable to connect to API (ConnectionRefused)`）：

```
千问办公 App
   └─ src/bridge-shim.mjs（换芯：把 Agent 引擎指向 claude）
        └─ claude.exe
             └─ claude-hub-bridge :8820（Anthropic <-> OpenAI 协议翻译）
                  └─ WorkBuddy Hub :8788（多账号反代网关）
                       └─ 上游账号池
```

## 前提

| 项 | 要求 | 谁负责 |
|---|---|---|
| Node.js | **≥ 22**（Claude Code 最新版要求） | 人工装一次 |
| 千问办公 App | 官网下载安装（**system 安装需管理员**） | 人工装一次 |
| WorkBuddy Hub | 一个能用的 hub（本机或云主机） | 见「第一步」 |
| Hub 账号 | OAuth 授权（**只需这一次人工**） | 见「第一步」 |

---

## 第一步：部署 Hub（反代网关）

Hub 是上游账号池网关，提供 OpenAI 兼容接口（`/v1/chat/completions`、`/v1/responses`）。

### 方式 A：Docker（推荐，最省事）

```powershell
# 建目录
mkdir $env:USERPROFILE\wb-hub; cd $env:USERPROFILE\wb-hub
mkdir accounts, usage

# 拉官方镜像并起容器（端口 8788，账号与用量落盘到当前目录）
docker run -d --name wb-proxy --restart unless-stopped `
  -p 8788:8788 `
  -v "$($PWD.Path)\accounts:/app/accounts" `
  -v "$($PWD.Path)\usage:/app/usage" `
  -e TZ=Asia/Shanghai `
  ghcr.io/ardeyouxipianyi/workbuddy2api-hub:latest
```

### 方式 B：便携 Python（免 Docker）

1. 到 <https://github.com/ardeyouxipianyi/workbuddy2api-hub/releases> 下载最新 `wb-proxy-vX.Y.Z.zip`（自带精简 Python）；
2. 解压到任意目录，双击 `start-wb-proxy.bat`，保持窗口开着。

### 绑账号（人工，唯一必须手动的一步）

打开看板 <http://127.0.0.1:8788/> →

- **推荐**：点「+ 添加账号 (OAuth)」，选区域（国内版 / 国际版），在浏览器完成授权，账号自动入库；
- 备选：点「📥 扫描桌面客户端账号」→ 从本机已登录的客户端导入。

> 首次登录后**立即到「设置」改默认面板密码**。
> 账号凭证是明文保存在 `accounts/*.json` 的——**绝不要提交到 git**，也不要同步到公共位置。

### 验证

```powershell
curl.exe -s http://127.0.0.1:8788/v1/models -H "Authorization: Bearer <你的key>"
```

返回模型列表（JSON）即成功。单机模式 key 可留空；若你建了 key，请记下来，翻译层要用。

---

## 第二步：装翻译层（含 Claude Code CLI 自动安装）

Claude Code 只会说 Anthropic 协议，Hub 只会说 OpenAI 协议，**中间必须有这一层**。

```powershell
cd $env:USERPROFILE\Documents
git clone https://github.com/ry76642230-cmd/claude-hub-bridge.git
cd claude-hub-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` 会自动完成：

| 步骤 | 动作 |
|---|---|
| `[0/5]` | 检查 node（≥22 告警）与千问办公（未装只给链接，不阻塞） |
| `[1/5]` | **自动安装 Claude Code CLI**（npm 用户级全局，无需管理员） |
| `[2/5]` | 写 `~/.claude/settings.json` 的 `env` 块（原文件自动备份，保留其它设置） |
| `[3/5]` | 注册看门狗计划任务（每 1 分钟保活 8820） |
| `[4/5]` | 写开机自启 VBS（无窗口） |
| `[5/5]` | 启动并健康检查 |

**健康检查必须看到 `hubKey: "set"`**：

```powershell
(Invoke-WebRequest http://127.0.0.1:8820/health).Content
# {"ok":true,"upstream":"http://127.0.0.1:8788","model":"deepseek-v4.1-flash","hubKey":"set"}
```

若显示 `"hubKey":"MISSING"`，给它一个 key（任选一种）：

```powershell
setx HUB_API_KEY "你在 Hub 看板建的 key"          # 方式 1：直接给 key
setx HUB_SETTINGS "D:\wb-hub\accounts\settings.json"  # 方式 2：指向 hub 的 settings.json
# 若 Hub 不在默认地址：setx HUB_BASE_URL "http://127.0.0.1:8788"
```
改完重启翻译层：`powershell -NoProfile -ExecutionPolicy Bypass -File restart-bridge.ps1`

**顺手验证 Claude 通了**：

```powershell
claude -p "reply with exactly: OK"
```

---

## 第三步：换芯千问办公

```powershell
cd $env:USERPROFILE\Documents
git clone https://github.com/ry76642230-cmd/clauded-qwenwork.git
```

### 两种启动方式，二选一

| 方式 | 效果 | 怎么用 |
|---|---|---|
| **启动器（推荐）** | 双击千问办公图标＝官方引擎；双击启动器＝走 Claude | 双击 `clauded-qwenwork\scripts\start-qwenwork.bat` |
| `pnpm apply` | **所有**启动方式都走 Claude（含双击图标、开机自启） | `cd clauded-qwenwork; pnpm install; pnpm apply` |

**为什么能二选一**：千问办公只按**进程启动那一刻的环境变量**决定用哪个 CLI（读 `QODER_CLI_PATH` / `QODERCLI_PATH`，不落盘）。启动器在自己的进程里临时注入这两个变量再拉起 app，就只有它走 Claude；`pnpm apply` 则把它们写进用户级注册表，于是**所有**新进程都带上。

> 想回到「双击＝官方」，执行 `pnpm unapply`。

### 验证

1. 千问办公界面发一条消息，能收到回复；
2. 再发一条（**同一会话第二轮**，验证会话复用）；
3. 看 shim 日志：`clauded-qwenwork\src\logs\` 有新文件＝shim 被调用；
4. 对照 App 日志 `%APPDATA%\QwenWorkCN\logs\<最新>\main.log`：
   - `Using custom QODER_CLI_PATH` ＝ ✅ 走 Claude
   - `Resolved bundled Qoder CLI path` ＝ ❌ 仍走官方引擎

---

## 排障顺序

从链路**下游往上游**查，先看最便宜的证据：

1. `8820` 在不在 → `(Invoke-WebRequest http://127.0.0.1:8820/health).Content`
   - 不在：`claude-hub-bridge\restart-bridge.ps1`；仍不行看 `logs\bridge.log` 与 `logs\watchdog.log`
2. `8788` 在不在 → `curl.exe -s http://127.0.0.1:8788/v1/models -H "Authorization: Bearer <key>"`
   - 不在：`docker start wb-proxy`（或重开 `start-wb-proxy.bat`）
3. `claude` 通不通 → `claude -p "reply with exactly: OK"`
4. shim 有没有被调用 → `clauded-qwenwork\src\logs\` 有没有新日志
5. App 走的哪个引擎 → 上面的 `main.log` 关键字对照

常见原因：
- **`hubKey: MISSING`** → 翻译层读不到 Hub key（见第二步）。
- **千问办公首次启动仍走官方** → app 有 `binaryPathComputed` 缓存，**必须完全退出**（所有 QwenWorkCN 进程）再启动；用启动器时它会自动 taskkill 旧实例。
- **改完环境变量没生效** → 环境变量在进程启动时读取，改完必须重启翻译层 / app。

## 已知坑（改这些文件时注意）

| 文件 | 坑 |
|---|---|
| `clauded-qwenwork\scripts\start-qwenwork.bat` | **GBK(936) 编码 + CRLF 行尾**，`.gitattributes` 标了 `-text` 禁止转换；改动时必须保持，否则 cmd 解析错乱/中文乱码 |
| `claude-hub-bridge\install.ps1` | 含中文，必须 **UTF-8 带 BOM** 保存；无 BOM 时 Windows PowerShell 5.1 按 ANSI 解析 → 语法错误 |
| Hub 的 `accounts\*.json` | 明文凭证，**禁止入 git / 禁云同步** |

## 更新与回滚

```powershell
# 更新翻译层
cd claude-hub-bridge; git pull; powershell -NoProfile -ExecutionPolicy Bypass -File restart-bridge.ps1

# 更新换芯层（上游有新提交时先合再推自己的 fork）
cd clauded-qwenwork; git pull

# 更新 Hub（Docker）
docker pull ghcr.io/ardeyouxipianyi/workbuddy2api-hub:latest
docker stop wb-proxy; docker rm wb-proxy; docker run ...（用第一步的命令重跑）

# 回滚换芯（恢复官方引擎）
cd clauded-qwenwork; pnpm unapply
```
