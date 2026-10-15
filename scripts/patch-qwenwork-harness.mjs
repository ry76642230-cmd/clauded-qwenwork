#!/usr/bin/env node
// patch-qwenwork-harness.mjs
// 让千问办公 1.3.x 重新使用 CLI harness（从而接上 clauded-qwenwork 换芯 + bridge）。
//
// 背景（2026-10-15 实测，1.3.1-26101419）：
//   1.3.1 起模型目录来源改为云端 chat-modes-v2，其模型声明 harness:"oc"；
//   代码把 "oc" 映射成 opencode（而非 qoder-cli），且目录提供者默认用
//   云端 DesktopChatModesV2CatalogProvider，导致 CLI 被绕开、模型列表只剩 3 个。
//
// 本脚本对 resources/app.asar 做两处「等长」替换（不改文件大小，asar 偏移不变）：
//   A) HOST_HARNESS_BY_CODE:  oc:"opencode"  ->  oc:"qoder-cli"
//      并以 qc 值 "qwencode" -> "qwencod" 抵消 1 字节（二者都 ≠ "qoder-cli"，行为等价）
//   B) 目录提供者交换：chat-modes-v2 用 QoderCliModelCatalogProvider
//
// 用法：
//   node patch-qwenwork-harness.mjs            # 自动找最新版本目录并打补丁
//   node patch-qwenwork-harness.mjs --revert   # 还原
//   node patch-qwenwork-harness.mjs --asar <路径>
// 退出码 0 = 成功（或已是目标状态）。

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = process.env.QWENWORK_ROOT || "C:\\Program Files\\QwenWorkCN";

const EDITS = [
  {
    name: "harness: oc -> qoder-cli",
    from: '{oc:"opencode",qc:"qwencode",cc:"qoder-cli",qo:"qoder-cli"}',
    to:   '{oc:"qoder-cli",qc:"qwencod",cc:"qoder-cli",qo:"qoder-cli"}',
  },
  {
    name: "catalog source: chat-modes-v2 -> QoderCli provider",
    from: 'strategies:{"chat-modes-v2":new DesktopChatModesV2CatalogProvider,qodercli:new QoderCliModelCatalogProvider}',
    to:   'strategies:{"chat-modes-v2":new QoderCliModelCatalogProvider,qodercli:new DesktopChatModesV2CatalogProvider}',
  },
];

function newestAsar() {
  if (!existsSync(ROOT)) throw new Error("找不到 " + ROOT);
  const dirs = readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const d of dirs) {
    const p = join(ROOT, d, "resources", "app.asar");
    if (existsSync(p)) return { version: d, asar: p };
  }
  throw new Error("未找到任何 app.asar");
}

const argv = process.argv.slice(2);
const revert = argv.includes("--revert");
const asarArgIdx = argv.indexOf("--asar");
let asarPath, version = "(explicit)";
if (asarArgIdx !== -1 && argv[asarArgIdx + 1]) {
  asarPath = argv[asarArgIdx + 1];
} else {
  const r = newestAsar();
  asarPath = r.asar; version = r.version;
}

console.log(`asar : ${asarPath}`);
console.log(`版本 : ${version}   模式: ${revert ? "还原" : "打补丁"}`);

const before = statSync(asarPath).size;
let s = readFileSync(asarPath).toString("latin1");
let changed = 0;
const unapplied = [];
const alreadyApplied = [];

for (const e of EDITS) {
  if (e.from.length !== e.to.length) throw new Error(`内部错误：${e.name} 长度不等`);
  const target = revert ? e.from : e.to;
  const source = revert ? e.to : e.from;
  const nSrc = s.split(source).length - 1;
  const nTgt = s.split(target).length - 1;
  if (nSrc === 1) {
    s = s.replace(source, target);
    changed++;
    console.log(`  [${revert ? "还原" : "补丁"}] ${e.name}`);
  } else if (nSrc === 0 && nTgt === 1) {
    alreadyApplied.push(e.name);
    console.log(`  [跳过] ${e.name}（${revert ? "本就未打" : "已是目标状态"}）`);
  } else {
    unapplied.push(`${e.name}（source=${nSrc}, target=${nTgt}）`);
    console.log(`  [!] ${e.name} 未匹配：source=${nSrc} target=${nTgt}`);
  }
}

if (changed > 0) {
  const out = Buffer.from(s, "latin1");
  if (out.length !== before) throw new Error("拒绝写入：文件大小发生变化");
  const bak = asarPath + (revert ? ".bak-before-revert" : ".bak-before-harness-patch");
  if (!existsSync(bak)) { copyFileSync(asarPath, bak); console.log("  备份 -> " + bak); }
  writeFileSync(asarPath, out);
  console.log(`已写入，大小不变 (${out.length})`);
} else {
  console.log("无需写入");
}

if (unapplied.length) {
  console.log("\n警告：以下补丁点未匹配，可能该版本代码已变动，需重新逆向：");
  for (const u of unapplied) console.log("  - " + u);
  process.exit(2);
}
console.log("\n完成。重启千问办公后生效。");
