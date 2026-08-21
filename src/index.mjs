#!/usr/bin/env node
// src/index.mjs — pnpm apply / pnpm unapply
// 注册或撤销用户级环境变量 QODER_CLI_PATH + QODERCLI_PATH，让千问办公走 Claude Code 桥接
// 跨平台：Windows（注册表 HKCU\Environment + WM_SETTINGCHANGE 广播）/ macOS（launchctl setenv + shell profile 持久化）
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { platform, homedir } from 'node:os';

const OS = platform();
// Windows 用 .mjs 文件（SDK 自动识别并调用 node）
// macOS 用 shell wrapper（因为 SDK spawn 时 PATH 不包含 /opt/homebrew/bin，找不到 node）
const SHIM_PATH = OS === 'win32'
  ? join(dirname(fileURLToPath(import.meta.url)), 'bridge-shim.mjs')
  : join(dirname(fileURLToPath(import.meta.url)), 'bridge-shim-wrapper.sh');
// App 壳层 (main.js getBundledQoderCliPath) 读 QODER_CLI_PATH；
// SDK 内核 (resolveExecutable) 读 QODERCLI_PATH（无下划线）。
// 两者必须同时注册，否则 shim 不会被调用。
const ENV_NAMES = ['QODER_CLI_PATH', 'QODERCLI_PATH'];

// macOS shell profile 标记（apply 写入，unapply 按标记清理）
const SHELL_MARKER = 'clauded-qwenwork';

// ---------- Windows 实现 ----------

const winGetCurrentValue = (name) => {
  try {
    const out = execSync(`reg query "HKCU\\Environment" /v ${name}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.*)/);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
};

const winSetReg = (name, value) =>
  execSync(`reg add "HKCU\\Environment" /v ${name} /t REG_SZ /d "${value}" /f`, { stdio: 'inherit' });

const winDelReg = (name) =>
  execSync(`reg delete "HKCU\\Environment" /v ${name} /f 2>nul`, { stdio: 'ignore' });

const winBroadcast = () => {
  try {
    execSync(
      'powershell -NoProfile -Command "'
      + "Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '"
      + '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]'
      + 'public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
      + "';"
      + '$result = [UIntPtr]::Zero;'
      + '[Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, \"Environment\", 2, 5000, [ref]$result)'
      + '"',
      { stdio: 'ignore' },
    );
  } catch {
    // 广播失败不阻塞主操作
  }
};

// ---------- macOS 实现 ----------

const macGetCurrentValue = (name) => {
  try {
    return execSync(`launchctl getenv ${name}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
};

const macSetEnv = (name, value) => {
  execSync(`launchctl setenv ${name} "${value}"`, { stdio: 'inherit' });
};

const macUnsetEnv = (name) => {
  try {
    execSync(`launchctl unsetenv ${name}`, { stdio: 'ignore' });
  } catch {
    // 变量不存在时 launchctl unsetenv 可能报错，忽略
  }
};

// shell profile 路径——macOS 默认 zsh，可通过 QODER_BRIDGE_SHELL_RC 覆盖
const macGetShellRC = () => {
  if (process.env.QODER_BRIDGE_SHELL_RC) return process.env.QODER_BRIDGE_SHELL_RC;
  const home = homedir();
  // 优先 zshrc（macOS 默认 shell），回退 bashrc
  if (existsSync(join(home, '.zshrc')) || !existsSync(join(home, '.bashrc'))) {
    return join(home, '.zshrc');
  }
  return join(home, '.bashrc');
};

const macAddToShellProfile = (name, value) => {
  const rc = macGetShellRC();
  const line = `export ${name}="${value}" # ${SHELL_MARKER}`;
  try {
    if (existsSync(rc)) {
      const content = readFileSync(rc, 'utf8');
      // 先清掉同名的旧标记行
      const cleaned = content
        .split('\n')
        .filter((l) => !l.includes(`# ${SHELL_MARKER}`))
        .join('\n');
      writeFileSync(rc, cleaned.trimEnd() + '\n' + line + '\n');
    } else {
      appendFileSync(rc, line + '\n');
    }
    console.log(`  已写入 ${rc}`);
  } catch (e) {
    console.log(`  写入 ${rc} 失败（${e.message}），仅 launchctl 生效，重启后需重新 pnpm apply`);
  }
};

const macRemoveFromShellProfile = () => {
  const home = homedir();
  let removed = 0;
  for (const rc of [join(home, '.zshrc'), join(home, '.bashrc')]) {
    try {
      if (!existsSync(rc)) continue;
      const content = readFileSync(rc, 'utf8');
      const cleaned = content
        .split('\n')
        .filter((l) => !l.includes(`# ${SHELL_MARKER}`))
        .join('\n');
      if (cleaned !== content) {
        writeFileSync(rc, cleaned);
        removed++;
        console.log(`  已清理 ${rc}`);
      }
    } catch {
      // 清理失败不阻塞
    }
  }
  return removed;
};

// ---------- 平台抽象层 ----------

const getCurrentValue = (name) =>
  OS === 'win32' ? winGetCurrentValue(name) : macGetCurrentValue(name);

const setEnv = (name, value) => {
  if (OS === 'win32') winSetReg(name, value);
  else macSetEnv(name, value);
  // 注意：macOS shell profile 写入在 apply() 统一处理，避免多次写入互相覆盖
};

const delEnv = (name) => {
  if (OS === 'win32') winDelReg(name);
  else macUnsetEnv(name);
};

const broadcastChange = () => {
  if (OS === 'win32') winBroadcast();
  // macOS launchctl setenv 立即生效，无需额外广播
};

// ---------- 命令 ----------

const apply = () => {
  for (const name of ENV_NAMES) {
    const existing = getCurrentValue(name);
    if (existing === SHIM_PATH) {
      console.log(`值未变，覆盖写入: ${name}=${SHIM_PATH}`);
    } else if (existing) {
      console.log(`替换旧值: ${name}\n  旧: ${existing}\n  新: ${SHIM_PATH}`);
    }
    setEnv(name, SHIM_PATH);
  }
  // macOS: 一次性写入所有环境变量到 shell profile（避免循环内每次写入互相覆盖）
  if (OS !== 'win32') {
    const rc = macGetShellRC();
    const lines = ENV_NAMES.map((name) => `export ${name}="${SHIM_PATH}" # ${SHELL_MARKER}`);
    try {
      let content = '';
      if (existsSync(rc)) {
        content = readFileSync(rc, 'utf8')
          .split('\n')
          .filter((l) => !l.includes(`# ${SHELL_MARKER}`))
          .join('\n');
      }
      writeFileSync(rc, content.trimEnd() + '\n' + lines.join('\n') + '\n');
      console.log(`  已写入 ${rc}`);
    } catch (e) {
      console.log(`  写入 ${rc} 失败（${e.message}），仅 launchctl 生效，重启后需重新 pnpm apply`);
    }
  }
  broadcastChange();
  console.log(`\n已注册（${OS === 'win32' ? 'Windows 注册表' : 'macOS launchctl + shell profile'}）:`);
  for (const name of ENV_NAMES) console.log(`  ${name}=${SHIM_PATH}`);
  if (OS === 'win32') {
    console.log('重启千问办公即可生效。');
  } else {
    console.log('重启千问办公即可生效（建议从终端启动以继承 shell profile）。');
  }
};

const unapply = () => {
  let removed = 0;
  for (const name of ENV_NAMES) {
    if (getCurrentValue(name)) {
      delEnv(name);
      removed++;
    }
  }
  if (OS !== 'win32') {
    macRemoveFromShellProfile();
  }
  if (removed === 0) {
    console.log('未注册，无需撤销。');
    return;
  }
  broadcastChange();
  console.log(`已撤销 ${removed} 个环境变量，重启千问办公恢复原引擎。`);
};

const cmd = process.argv[2];
if (cmd === 'apply') apply();
else if (cmd === 'unapply') unapply();
else {
  console.log('用法:');
  console.log('  pnpm apply    注册 QODER_CLI_PATH + QODERCLI_PATH → 千问办公走 Claude Code');
  console.log('  pnpm unapply  撤销两个变量 → 恢复原引擎');
  console.log(`\n当前平台: ${OS}（${OS === 'win32' ? 'Windows 注册表' : 'macOS launchctl + shell profile'}）`);
}
