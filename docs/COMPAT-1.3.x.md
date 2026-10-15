# 千问办公 1.3.x 兼容补丁（让 CLI 换芯继续可用）

## 问题

千问办公 **1.3.1** 起改了模型目录与执行链，导致 CLI 换芯（`QODER_CLI_PATH` → bridge-shim → claude）对主对话失效：

| 变化 | 后果 |
|---|---|
| 模型目录来源改为云端 `chat-modes-v2`（`DesktopChatModesV2CatalogProvider`） | 模型下拉只剩云端 3 个（标准/高级/Qwen3.8-Max），Hub 的模型不可见 |
| 云端模型声明 `harness:"oc"`，代码映射 `oc → "opencode"`（非 `qoder-cli`） | 执行走 opencode harness，**绕过 qoder CLI**，换芯失效 |

代码证据（1.3.1 `app.asar`）：

```js
HOST_HARNESS_BY_CODE = Object.freeze({ oc:"opencode", qc:"qwencode", cc:"qoder-cli", qo:"qoder-cli" })
FALLBACK_HARNESS = "opencode"
// adaptMode: a = resolveHarness(mode.harness); o = a === "qoder-cli" ? "openai" : resolveApiProtocol(mode.format)
modelCatalogSourceExtension = { strategies: { "chat-modes-v2": …, qodercli: … }, defaultId: "chat-modes-v2" }
```

## 补丁

对 `resources/app.asar` 做**两处等长字节替换**（文件大小不变 → asar 内偏移不变，无需重打包）：

| # | 原始 | 替换后 | 作用 |
|---|---|---|---|
| A | `{oc:"opencode",qc:"qwencode",cc:"qoder-cli",qo:"qoder-cli"}` | `{oc:"qoder-cli",qc:"qwencod",cc:"qoder-cli",qo:"qoder-cli"}` | `oc → qoder-cli`；`qwencode→qwencod` 仅抵消 1 字节（二者都 ≠ `qoder-cli`，行为等价） |
| B | `strategies:{"chat-modes-v2":new DesktopChatModesV2CatalogProvider,qodercli:new QoderCliModelCatalogProvider}` | `strategies:{"chat-modes-v2":new QoderCliModelCatalogProvider,qodercli:new DesktopChatModesV2CatalogProvider}` | 默认目录提供者改用 **QoderCli**（交换类名，长度不变） |

## 用法

```powershell
# 打补丁（自动选最新版本目录；会先备份 app.asar）
node scripts\patch-qwenwork-harness.mjs

# 还原
node scripts\patch-qwenwork-harness.mjs --revert

# 指定 asar
node scripts\patch-qwenwork-harness.mjs --asar "C:\...\resources\app.asar"
```

打完补丁后**重启千问办公**，再用启动器（`scripts\start-qwenwork.bat`）以 Claude 模式启动。

## 验证（2026-10-15，1.3.1-26101419 实测通过）

| 指标 | 结果 |
|---|---|
| App 日志 | `Using custom QODER_CLI_PATH` ✅ |
| 模型数量 | `getQoderWorkModels() completed {modelCount:16}`（补丁前为 3）✅ |
| 目录告警 | `unsupported harness` / `unrecognized format` 均为 0 ✅ |
| 模型下拉 | 显示 `Deepseek-V4.1-Flash`（Hub 模型，补丁前是云端 `flash`）✅ |
| 真实会话 | shim 日志出现 `[MODE] real session sessionId=…`，界面 3.8s 返回正确内容 ✅ |

## 风险与注意

- **补丁点写死在代码字面量上**：千问办公再升级后，若这两处代码变动，脚本会报「未匹配」（退出码 2），需重新定位（用 `node -e` 在 asar 里搜 `HOST_HARNESS_BY_CODE` / `chat-modes-v2`）。
- **可能被覆盖**：应用启动时会在版本目录内写 `plugin-market-data.json` 等文件；个别情况下版本目录会被"修复/重装"，把 `app.asar` 还原（本轮观察到过一次 harness 补丁丢失）。升级或异常后**重跑一次脚本即可**（脚本幂等，已打过会提示跳过）。
- 备份文件为 `app.asar.bak-before-harness-patch`，占 264MB，确认稳定后可删。
- **不改 UI、不改登录/计费**；只是把客户端本来就有、但 1.3.1 默认不用的 **qoder-cli harness** 重新设为默认，执行仍走本机 bridge → Hub → 你自己的账号额度。

---

## 已在启动器里自动执行（2026-10-15 追加）

`scripts/start-qwenwork.bat` 现在会在选定版本后**自动调用本补丁脚本**（幂等）：

```
[OK] harness compat patch applied/present
```

- 每次启动都检查一次，所以即使 `app.asar` 被应用还原，下一次用启动器就会自动补回。
- 如果补丁点变了（新版本代码改动），会打印
  `[X] harness patch points not matched - need re-RE`，此时需按上文重新定位字符串。

## 重要发现：应用会自动重装缺失的版本

本轮实测：把当前版本目录改名后，应用**自动重新下载并安装了同一个版本**（约 1.5GB）。
推论：

- **不要靠「把版本目录改名」来长期停用某个版本** —— 应用会把它下回来（这也解释了为什么补丁会莫名消失一次）。
- 删除**旧**版本目录是安全的（不会被重新下载，因为它们不是"当前版本"）。
- 因此：**保持当前版本为最新，并让启动器自动补补丁**，是最稳的组合。
