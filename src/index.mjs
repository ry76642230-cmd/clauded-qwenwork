#!/usr/bin/env node
// src/index.mjs — pnpm apply / pnpm unapply
// 注册或撤销用户级环境变量 QODER_CLI_PATH，让千问办公走 Claude Code 桥接
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SHIM_PATH = join(dirname(fileURLToPath(import.meta.url)), 'bridge-shim.mjs');
const REG_KEY = 'HKCU\\Environment';
// App 壳层 (main.js getBundledQoderCliPath) 读 QODER_CLI_PATH；
// SDK 内核 (resolveExecutable) 读 QODERCLI_PATH（无下划线）。
// 两者必须同时注册，否则 shim 不会被调用。
const REG_VALS = ['QODER_CLI_PATH', 'QODERCLI_PATH'];

const broadcastSettingChange = () => {
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

const getCurrentValue = (name) => {
  try {
    const out = execSync(`reg query "${REG_KEY}" /v ${name}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.*)/);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
};

const setReg = (name, value) =>
  execSync(`reg add "${REG_KEY}" /v ${name} /t REG_SZ /d "${value}" /f`, { stdio: 'inherit' });
const delReg = (name) =>
  execSync(`reg delete "${REG_KEY}" /v ${name} /f 2>nul`, { stdio: 'ignore' });

const apply = () => {
  for (const name of REG_VALS) {
    const existing = getCurrentValue(name);
    if (existing === SHIM_PATH) {
      console.log(`值未变，覆盖写入: ${name}=${SHIM_PATH}`);
    } else if (existing) {
      console.log(`替换旧值: ${name}\n  旧: ${existing}\n  新: ${SHIM_PATH}`);
    }
    setReg(name, SHIM_PATH);
  }
  broadcastSettingChange();
  console.log(`\n已注册:`);
  for (const name of REG_VALS) console.log(`  ${name}=${SHIM_PATH}`);
  console.log('重启千问办公即可生效。');
};

const unapply = () => {
  let removed = 0;
  for (const name of REG_VALS) {
    if (getCurrentValue(name)) { delReg(name); removed++; }
  }
  if (removed === 0) { console.log('未注册，无需撤销。'); return; }
  broadcastSettingChange();
  console.log(`已撤销 ${removed} 个环境变量，重启千问办公恢复原引擎。`);
};

const cmd = process.argv[2];
if (cmd === 'apply') apply();
else if (cmd === 'unapply') unapply();
else {
  console.log('用法:');
  console.log('  pnpm apply    注册 QODER_CLI_PATH + QODERCLI_PATH → 千问办公走 Claude Code');
  console.log('  pnpm unapply  撤销两个变量 → 恢复原引擎');
}
