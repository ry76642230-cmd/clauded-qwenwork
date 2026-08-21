#!/usr/bin/env node
// bridge-shim.mjs — 千问办公 → Claude Code 桥接翻译层
//
// 被 @qoder-ai/qoder-agent-sdk 的 ProcessTransport 当作 CLI spawn（QODER_CLI_PATH 指向本文件）。
// 职责：
//   1. 内部查询（模型列表/闲置建议）→ 本地自答，不消耗 token
//   2. 真实会话 → 参数翻译后 spawn claude，双向翻译协议
//   3. 应答 SDK 的 control_request；改写 claude 事件；记账
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// ---------- 配置 ----------
// claude.exe 完整路径——千问办公进程的 PATH 通常不含 npm 全局目录，必须绝对路径
const CLAUDE_BIN = process.env.QODER_BRIDGE_CLAUDE
  ?? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const BRIDGE_MODEL = process.env.QODER_BRIDGE_MODEL; // 可选：强制指定 claude 模型
const PROTOCOL_VERSION = '1.2.0';
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'logs');
const LEDGER_DIR = join(homedir(), '.qwenwork-bridge');
const LEDGER_FILE = join(LEDGER_DIR, 'ledger.jsonl');
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(LEDGER_DIR, { recursive: true });

const logFile = join(LOG_DIR, `bridge-${process.pid}-${Date.now()}.log`);
const log = (tag, data) => {
  try { appendFileSync(logFile, `${new Date().toISOString()} [${tag}] ${data}\n`); } catch {}
};
const ledger = (entry) => {
  try { appendFileSync(LEDGER_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + '\n'); } catch {}
};

// ---------- 协议工具 ----------
const controlResponse = (requestId, response) =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n';

const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1', 'session_rewind_v1', 'background_tasks_v1'];

const INIT_RESPONSE = () => ({
  commands: [], agents: [], skills: [], output_style: 'default', available_output_styles: [],
  models: [], account: {}, capabilities: CAPABILITIES, pid: process.pid,
});
const MODELS_RESPONSE = () => ({
  models: [{ value: 'claude-bridge', displayName: 'Claude', description: '使用强大的 Claude Code 代理后端', modelId: 'claude-bridge', source: 'system', isDefault: true }],
});
const CONTEXT_USAGE_RESPONSE = () => ({
  categories: [
    { name: 'User Messages', tokens: 0, color: '#3b82f6' },
    { name: 'Assistant Messages', tokens: 0, color: '#22c55e' },
    { name: 'Thinking', tokens: 0, color: '#8b5cf6' },
  ],
  totalTokens: 0, maxTokens: 0, rawMaxTokens: 0, percentage: 0, gridRows: [],
});

// ---------- 参数解析 ----------
// qoder 工具名 → claude 工具名（UI 展示用）
const TOOL_MAP = { Task: 'Agent', TodoWrite: 'TaskCreate' };

// 有值参数（透传候选）
const VALUE_ARGS = new Set([
  '--output-format', '--input-format', '--session-id', '--model', '--context-window',
  '--permission-mode', '--setting-sources', '--settings', '--mcp-config', '--tools',
  '--allowed-tools', '--disallowed-tools', '--resume', '--add-dir', '--agent',
  '--plugin-dir', '--images', '--include', '--allowed-mcp-server-names',
  '--system-prompt', '--append-system-prompt', '--max-budget-usd', '--max-output-tokens',
]);
// 无值参数
const FLAG_ARGS = new Set([
  '--print', '--bare', '--continue', '--fork-session', '--include-partial-messages',
  '--debug', '--no-session-persistence', '--strict-mcp-config', '--yolo',
]);

const PM_MAP = {
  default: null,                    // 不传 → claude 用主人配置
  accept_edits: 'acceptEdits',
  bypassPermissions: 'bypassPermissions',
  dont_ask: 'dontAsk',
  auto: 'auto',
  plan: 'plan',
};

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_ARGS.has(a)) { values.set(a, argv[++i]); }
    else if (FLAG_ARGS.has(a)) { flags.add(a); }
    else { log('DROP', a); }
  }
  const get = (k) => values.get(k);

  // 内部查询判定：--bare 或 --disallowed-tools * 或 --tools 空串
  const internal = flags.has('--bare') || get('--disallowed-tools') === '*' || get('--tools') === '';

  // 组装 claude 参数
  const claudeArgs = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
  for (const f of ['--include-partial-messages', '--continue', '--fork-session', '--debug', '--no-session-persistence']) {
    if (flags.has(f)) claudeArgs.push(f);
  }
  for (const v of ['--session-id', '--resume', '--add-dir', '--agent', '--images', '--include',
                   '--plugin-dir', '--allowed-mcp-server-names', '--system-prompt', '--append-system-prompt',
                   '--max-budget-usd', '--max-output-tokens']) {
    if (get(v) !== undefined) claudeArgs.push(v, get(v));
  }
  // MCP：qw-builtin 网关必须透传（千问办公的工具通道）；--strict-mcp-config 丢弃（让主人既有 MCP 共存）
  if (get('--mcp-config') !== undefined) claudeArgs.push('--mcp-config', get('--mcp-config'));
  // 权限：交给 claude 侧配置（主人的 ~/.claude/settings.json）
  const pm = PM_MAP[get('--permission-mode')];
  if (pm) claudeArgs.push('--permission-mode', pm);
  // 模型：qwork-* 丢弃；QODER_BRIDGE_MODEL 显式指定
  if (BRIDGE_MODEL) claudeArgs.push('--model', BRIDGE_MODEL);
  // --setting-sources / --settings / --tools / --allowed-tools / --disallowed-tools：丢弃
  //   （claude 默认加载 user/project/local；qoder settings 字段 claude 不认；工具集用 claude 默认全套）

  return { internal, claudeArgs, sessionId: get('--session-id') ?? null };
}

// ---------- 内部查询：自答，不 spawn claude ----------
function runInternal() {
  log('MODE', 'internal (self-answered, no claude spawn)');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== 'control_request') return;
    const req = msg.request ?? {};
    const subtype = req.subtype ?? req.type ?? 'unknown';
    let resp;
    switch (subtype) {
      case 'initialize': resp = INIT_RESPONSE(); break;
      case 'get_models': resp = MODELS_RESPONSE(); break;
      default: resp = {};
    }
    process.stdout.write(controlResponse(msg.request_id, resp));
  });
  rl.on('close', () => { log('EXIT', 'code=0 (internal)'); process.exitCode = 0; });
}

// ---------- 真实会话：spawn claude + 双向翻译 ----------
function runSession(parsed) {
  log('MODE', `real session sessionId=${parsed.sessionId} claudeArgs=${JSON.stringify(parsed.claudeArgs)}`);

  const child = spawn(CLAUDE_BIN, parsed.claudeArgs, {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'qwenwork-bridge' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('error', (e) => { log('ERROR', e.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { log('EXIT', `code=${code} signal=${signal}`); process.exitCode = code ?? 1; });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { try { child.kill(sig); } catch {} });
  }

  let lastUserText = '';
  let claudeReady = false;
  const pendingStdin = [];

  const flush = () => {
    if (!claudeReady) return;
    for (const l of pendingStdin.splice(0)) {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(l + '\n');
    }
  };

  // ---- stdin：拦截 control_request / control_response，透传 user ----
  const stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  stdinRl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.type === 'control_request') {
      const req = msg.request ?? {};
      const subtype = req.subtype ?? req.type ?? 'unknown';
      let resp;
      switch (subtype) {
        case 'initialize': resp = INIT_RESPONSE(); break;
        case 'get_models': resp = MODELS_RESPONSE(); break;
        case 'get_context_usage': resp = CONTEXT_USAGE_RESPONSE(); break;
        case 'generate_session_title':
          resp = { title: (String(req.description ?? lastUserText ?? '').trim() || '会话').slice(0, 20) };
          break;
        case 'interrupt':
          try { child.kill('SIGTERM'); } catch {}
          resp = { still_queued: [] };
          break;
        default:
          log('CTRL-UNHANDLED', subtype);
          resp = {};
      }
      process.stdout.write(controlResponse(msg.request_id, resp));
      return;
    }

    if (msg.type === 'control_response') {
      // SDK 应答 CLI 的请求（get_model_policy 等）——claude 不需要，丢弃
      return;
    }

    if (msg.type === 'user' && msg.message) {
      const text = extractText(msg.message);
      if (text) lastUserText = text;
      pendingStdin.push(JSON.stringify({ type: 'user', message: msg.message }));
      flush();
    }
  });
  stdinRl.on('close', () => {
    if (claudeReady && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  });

  // ---- stdout：claude 事件改写后透传 ----
  const outRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  outRl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }

    if (msg.type === 'system' && msg.subtype === 'init') {
      // 注入 qoder 握手所需字段；工具名翻译为 qoder 名称（UI 展示用）
      msg.protocol_version = PROTOCOL_VERSION;
      if (Array.isArray(msg.tools)) msg.tools = msg.tools.map((t) => TOOL_MAP[t] ?? t);
      process.stdout.write(JSON.stringify(msg) + '\n');
      return;
    }

    if (msg.type === 'assistant' && msg.message?.content) {
      // 工具名映射：claude Task（子代理）→ qoder Agent（UI 卡片）
      for (const block of msg.message.content) {
        if (block.type === 'tool_use' && TOOL_MAP[block.name]) block.name = TOOL_MAP[block.name];
      }
      process.stdout.write(JSON.stringify(msg) + '\n');
      return;
    }

    if (msg.type === 'result') {
      ledger({
        sessionId: msg.session_id ?? parsed.sessionId,
        model: msg.model ?? null,
        total_cost_usd: msg.total_cost_usd ?? 0,
        num_turns: msg.num_turns ?? 0,
        duration_ms: msg.duration_ms ?? 0,
        is_error: msg.is_error ?? false,
        result_preview: String(msg.result ?? '').slice(0, 120),
      });
      process.stdout.write(JSON.stringify(msg) + '\n');
      return;
    }

    process.stdout.write(line + '\n');
  });

  child.on('spawn', () => {
    claudeReady = true;
    flush();
  });
}

function extractText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  }
  return '';
}

// ---------- 入口 ----------
const parsed = parseArgs(process.argv.slice(2));
log('ARGV', JSON.stringify(process.argv.slice(2)));
log('ENV', JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^QODER/i.test(k)))));
log('CWD', process.cwd());

if (parsed.internal) runInternal();
else runSession(parsed);
