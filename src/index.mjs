#!/usr/bin/env node
// src/index.mjs — pnpm apply / pnpm unapply
// 注册或撤销用户级环境变量 QODER_CLI_PATH，让千问办公走 Claude Code 桥接
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SHIM_PATH = join(dirname(fileURLToPath(import.meta.url)), 'bridge-shim.mjs');
const REG_KEY = 'HKCU\\Environment';
const REG_VAL = 'QODER_CLI_PATH';

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

const getCurrentValue = () => {
  try {
    const out = execSync(`reg query "${REG_KEY}" /v ${REG_VAL}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.*)/);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
};

const apply = () => {
  const existing = getCurrentValue();
  if (existing === SHIM_PATH) {
    console.log(`值未变，覆盖写入:\n  QODER_CLI_PATH=${SHIM_PATH}`);
  } else if (existing) {
    console.log(`替换旧值:\n  旧: ${existing}\n  新: ${SHIM_PATH}`);
  }
  execSync(`reg add "${REG_KEY}" /v ${REG_VAL} /t REG_SZ /d "${SHIM_PATH}" /f`, { stdio: 'inherit' });
  broadcastSettingChange();
  console.log(`\n已注册:\n  QODER_CLI_PATH=${SHIM_PATH}`);
  console.log('重启千问办公即可生效。');
};

const unapply = () => {
  const existing = getCurrentValue();
  if (!existing) {
    console.log('未注册，无需撤销。');
    return;
  }
  execSync(`reg delete "${REG_KEY}" /v ${REG_VAL} /f`, { stdio: 'inherit' });
  broadcastSettingChange();
  console.log('已撤销 QODER_CLI_PATH，重启千问办公恢复原引擎。');
};

const cmd = process.argv[2];
if (cmd === 'apply') apply();
else if (cmd === 'unapply') unapply();
else {
  console.log('用法:');
  console.log('  pnpm apply    注册 QODER_CLI_PATH → 千问办公走 Claude Code');
  console.log('  pnpm unapply  撤销 QODER_CLI_PATH → 恢复原引擎');
}
