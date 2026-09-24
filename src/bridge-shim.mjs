#!/usr/bin/env node
// bridge-shim.mjs — 千问办公 → Claude Code 桥接翻译层
//
// 被 @qoder-ai/qoder-agent-sdk 的 ProcessTransport 当作 CLI spawn（QODER_CLI_PATH 指向本文件）。
// 职责：
//   1. 内部查询（模型列表/闲置建议）→ 本地自答，不消耗 token
//   2. 真实会话 → 参数翻译后 spawn claude，双向翻译协议
//   3. 应答 SDK 的 control_request；改写 claude 事件；记账
import { spawn, execSync as _execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

// ---------- 配置 ----------
// claude 可执行文件路径——千问办公进程的 PATH 通常不含 npm 全局目录，尽量用绝对路径
// 优先 QODER_BRIDGE_CLAUDE 显式覆盖；否则按平台猜默认位置
const DEFAULT_CLAUDE_BIN = (() => {
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  }
  // macOS / Linux：优先 npm 全局前缀下的标准位置，回退到 PATH 上的 claude
  let npmPrefix = '';
  try { npmPrefix = _execSync('npm prefix -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  if (npmPrefix) {
    const candidate = join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude');
    if (existsSync(candidate)) return candidate;
  }
  // 常见全局路径硬编码回退（Homebrew Node 等）
  for (const p of [
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    join(homedir(), '.npm-global', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude'),
  ]) {
    if (existsSync(p)) return p;
  }
  // 回退到 PATH 查找（macOS 终端启动千问办公时 PATH 含 /usr/local/bin 等）
  return 'claude';
})();
const CLAUDE_BIN = process.env.QODER_BRIDGE_CLAUDE ?? DEFAULT_CLAUDE_BIN;
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
  '--permission-prompt-tool',
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

// 运行时 set_permission_mode 的词汇表（两套都认，且 'default' 在这里是合法值，
// 不能像 PM_MAP 那样映射成「不传」）：
//   app（千问办公 UI）：request_approval / full_access / auto_review
//   claude：default / acceptEdits / bypassPermissions / dontAsk / auto / plan
const RUNTIME_MODE_MAP = {
  request_approval: 'default',
  full_access: 'bypassPermissions',
  auto_review: 'auto',
  default: 'default',
  accept_edits: 'acceptEdits',
  acceptEdits: 'acceptEdits',
  bypassPermissions: 'bypassPermissions',
  dont_ask: 'dontAsk',
  dontAsk: 'dontAsk',
  auto: 'auto',
  plan: 'plan',
  yolo: 'bypassPermissions',
};

// claude 的 --session-id 若指向已存在的会话，会直接报
//   Error: Session ID xxx is already in use.
// 并立即退出；而千问办公/SDK 的多轮对话会复用同一个 session id，
// 导致第二轮起必然失败。检测到该 id 已有会话文件时，改用 --resume 续接。
function claudeSessionFileFor(sessionId) {
  if (!sessionId) return null;
  const projectsRoot = join(homedir(), '.claude', 'projects');
  const slug = process.cwd().replace(/[:\\/]+/g, '-');
  const direct = join(projectsRoot, slug, sessionId + '.jsonl');
  if (existsSync(direct)) return direct;
  try {
    for (const d of readdirSync(projectsRoot)) {
      const candidate = join(projectsRoot, d, sessionId + '.jsonl');
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

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
  // 权限模式：app 恒传 default（只有 plan 会话例外），「完全访问」是 app 侧在 canUseTool
  // 回调里自动批准，所以模式本身透传；default → 不传，交给 claude 默认行为。
  // QODER_BRIDGE_PERMISSION_MODE 可强制覆盖（排障用）。
  const pm = PM_MAP[process.env.QODER_BRIDGE_PERMISSION_MODE ?? get('--permission-mode')];
  if (pm) claudeArgs.push('--permission-mode', pm);
  // 审批通道必须保住：claude 用 `can_use_tool` 控制请求反问宿主，宿主答 allow/deny。
  // 这个参数一旦丢掉，claude 就没人可问 —— 表现就是每条 Bash/跨目录读写都
  // 「requires approval」或「may only read files in the allowed working directories」，
  // 且千问办公的「完全访问」开关永远不生效。
  if (get('--permission-prompt-tool') === 'stdio') claudeArgs.push('--permission-prompt-tool', 'stdio');
  // 模型：qwork-* 丢弃；QODER_BRIDGE_MODEL 显式指定
  if (BRIDGE_MODEL) claudeArgs.push('--model', BRIDGE_MODEL);
  // --setting-sources / --settings / --tools / --allowed-tools / --disallowed-tools：丢弃
  //   （claude 默认加载 user/project/local；qoder settings 字段 claude 不认；工具集用 claude 默认全套）

  // ---- session id 复用处理 ----
  const sessionId = get('--session-id') ?? null;
  if (sessionId && get('--resume') === undefined) {
    const existing = claudeSessionFileFor(sessionId);
    if (existing) {
      log('SESSION', 'session id already exists, switching to --resume: ' + existing);
      const at = claudeArgs.indexOf('--session-id');
      if (at !== -1) claudeArgs.splice(at, 2);
      claudeArgs.push('--resume', sessionId);
    }
  }

  return { internal, claudeArgs, sessionId };
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

  // 先占位声明：spawn 的 error/exit 回调可能在下面赋值前触发，
  // 用可选链避免 TDZ/undefined 崩溃。
  let stdinRl = null;

  const child = spawn(CLAUDE_BIN, parsed.claudeArgs, {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'qwenwork-bridge' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('error', (e) => {
    log('ERROR', e.message);
    process.exitCode = 1;
    try { stdinRl?.close(); } catch {}
    setImmediate(() => { try { process.exit(1); } catch {} });
  });
  child.on('exit', (code, signal) => {
    log('EXIT', `code=${code} signal=${signal}`);
    process.exitCode = code ?? 1;
    // claude 已死：立刻关掉 stdin 读取与 stdout，让 SDK 收到流结束信号，
    // 否则千问办公会一直挂着等响应。
    try { stdinRl?.close(); } catch {}
    try { child.stdin.destroy(); } catch {}
    setImmediate(() => { try { process.exit(process.exitCode ?? 0); } catch {} });
  });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { try { child.kill(sig); } catch {} });
  }

  let lastUserText = '';
  let claudeReady = false;
  const pendingStdin = [];
  // 我们转给 App 的审批请求 id；只有这些 id 的回执才该回写给 claude，
  // 避免把无关的 control_response 灌进 claude 的 stdin。
  const pendingApprovalIds = new Set();

  const flush = () => {
    if (!claudeReady) return;
    for (const l of pendingStdin.splice(0)) {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(l + '\n');
    }
  };

  // ---- stdin：拦截 control_request / control_response，透传 user ----
  stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
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
        // 权限模式切换必须落到 claude 自己身上，否则千问办公里切「完全访问」
        // 只改了 UI 状态，claude 那边还是 default，命令照样被拦。
        // 原样转发给 claude，它的 control_response 会经 stdout 回给 App。
        // 注：当前 1.2.1 的 App 实际不发这个请求（其 RC 能力表里
        // supports_set_permission_mode=false，「完全访问」是 App 在 canUseTool
        // 里自动批准）；这里保留转发是为了将来 App 版本变化时仍能正确工作。
        case 'set_permission_mode': {
          const mode = RUNTIME_MODE_MAP[req.mode] ?? req.mode;
          if (mode && child.stdin.writable) {
            child.stdin.write(JSON.stringify({ type: 'control_request', request_id: msg.request_id, request: { ...req, mode } }) + '\n');
            log('FWD', `set_permission_mode ${req.mode} -> ${mode}`);
            return; // 不本地作答，等 claude 的 control_response
          }
          resp = { ok: false, error: `unsupported permission mode: ${req.mode}` };
          break;
        }
        default:
          log('CTRL-UNHANDLED', subtype);
          resp = {};
      }
      process.stdout.write(controlResponse(msg.request_id, resp));
      return;
    }

    if (msg.type === 'control_response') {
      // App 应答 claude 的请求。当前只有一类：can_use_tool（宿主审批）。
      // 必须回给 claude，否则它的工具调用永远等不到答复。
      const rid = msg.response?.request_id;
      if (rid && pendingApprovalIds.has(rid) && child.stdin.writable) {
        pendingApprovalIds.delete(rid);
        child.stdin.write(JSON.stringify(msg) + '\n');
        log('APPROVAL', `app -> claude ${msg.response.subtype} ${rid}`);
      }
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

    // claude 反问宿主能否用某个工具（Bash/Write/跨目录 Read 等）→ 原样转给 App，
    // 由 App 的 canUseTool 回调决定（「完全访问」= 自动批准）。App 的答复会以
    // control_response 回到 stdin 分支，再转发给 claude。
    if (msg.type === 'control_request' && (msg.request?.subtype ?? msg.request?.type) === 'can_use_tool') {
      pendingApprovalIds.add(msg.request_id);
      process.stdout.write(JSON.stringify(msg) + '\n');
      log('ASK', `can_use_tool ${msg.request.tool_name} ${msg.request.blocked_path ?? ''}`.trim());
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
