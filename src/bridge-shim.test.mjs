// bridge-shim.test.mjs — 模拟 SDK 调用 bridge-shim.mjs 的完整流程（内部查询 + 真实会话多轮）
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, 'bridge-shim.mjs');
const CWD = HERE;

let failures = 0;
const ok = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failures++; };

// ---------- 测试 1：内部查询（模型列表，--bare）----------
function runInternalDriven() {
  return new Promise((resolve) => {
    console.log('\n===== 1. internal model-list query (--bare) =====');
    const c = spawn('node', [SHIM, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--disallowed-tools', '*', '--bare'], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: c.stdout, crlfDelay: Infinity });
    const responses = [];
    c.stdin.write(JSON.stringify({ type: 'control_request', request_id: 't1', request: { type: 'initialize' } }) + '\n');
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        responses.push(msg);
        if (msg.type === 'control_response') {
          if (responses.length === 1) {
            c.stdin.write(JSON.stringify({ type: 'control_request', request_id: 't2', request: { subtype: 'get_models' } }) + '\n');
          } else if (responses.length === 2) {
            ok(Array.isArray(msg.response?.response?.models), 'get_models 返回 models 列表');
            c.stdin.end();
          }
        }
      } catch {}
    });
    c.on('exit', (code) => {
      ok(code === 0, 'exit 0');
      ok(responses.length === 2, `恰好 2 个 control_response (got ${responses.length})`);
      resolve();
    });
  });
}

// ---------- 测试 2：真实会话多轮（模拟 app 主对话 argv）----------
function runSessionDriven() {
  return new Promise((resolve) => {
    console.log('\n===== 2. real session multi-turn =====');
    const argv = [
      '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--session-id', '11111111-2222-3333-4444-555555555555',
      '--permission-mode', 'default', '--include-partial-messages', '--allowed-tools', 'Skill',
      '--tools', 'Agent,AskUserQuestion,Bash,Edit,Glob,Grep,ImageGen,ImageSearch,NotebookEdit,Read,Skill,TaskCreate,TaskGet,TaskUpdate,TaskList,WebFetch,WebSearch,Write',
      '--permission-prompt-tool', 'stdio',
      '--mcp-config', '{"mcpServers":{"qw-builtin":{"type":"http","url":"http://127.0.0.1:54365/chat/x"}}}',
      '--strict-mcp-config', '--settings', '{"outputStyle":"default"}',
      '--setting-sources', 'project,user', '--disable-builtin-skills',
      '--model', 'qwork-lite', '--context-window', '1000000',
    ];
    const c = spawn('node', [SHIM, ...argv], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: c.stdout, crlfDelay: Infinity });
    let state = 'init-sent';
    let results = 0;
    let initInjected = false;
    c.stderr.on('data', (d) => process.stderr.write('[shim-stderr] ' + d));
    c.stdin.write(JSON.stringify({ type: 'control_request', request_id: 's1', request: { type: 'initialize', modelPolicyProvider: true, supportsCatalogReadyInitialize: true, initializeTimeoutMs: 120000 } }) + '\n');

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'control_response') {
          ok(msg.response?.subtype === 'success', `initialize 应答成功 (state=${state})`);
          if (state === 'init-sent') {
            state = 'user1-sent';
            c.stdin.write(JSON.stringify({ type: 'user', session_id: '11111111-2222-3333-4444-555555555555', message: { role: 'user', content: [{ type: 'text', text: '请回复两个字：连接' }] } }) + '\n');
          }
        } else if (msg.type === 'system' && msg.subtype === 'init') {
          initInjected = true;
          ok(msg.protocol_version === '1.2.0', 'init 注入 protocol_version=1.2.0');
        } else if (msg.type === 'result') {
          results++;
          ok(!msg.is_error, `result#${results} is_error=false`);
          if (results === 1) {
            state = 'user2-sent';
            c.stdin.write(JSON.stringify({ type: 'user', session_id: '11111111-2222-3333-4444-555555555555', message: { role: 'user', content: [{ type: 'text', text: '再回复两个字：成功' }] } }) + '\n');
          } else {
            c.stdin.end();
          }
        }
      } catch {}
    });
    c.on('exit', (code) => {
      ok(code === 0, 'exit 0');
      ok(results === 2, `两轮 result (got ${results})`);
      ok(initInjected, 'system/init 注入');
      resolve();
    });
  });
}

// ---------- 测试 3：权限审批通道（回归防线）----------
// 曾经丢过 --permission-prompt-tool stdio + 不转发 can_use_tool，导致千问办公里
// 每条 Bash / 跨目录读写都卡在 "requires approval"，且「完全访问」开关形同虚设。
// 这里锁住三件事：① 参数透传；② claude 的 can_use_tool 能冒到宿主；
// ③ 宿主的 control_response 能回到 claude；④ set_permission_mode 能落到 claude。
function runApprovalRelay() {
  return new Promise((resolve) => {
    console.log('\n===== 3. permission approval relay =====');
    // 刻意用工作区之外的路径：只有审批通道真的通了，这次读取才可能成功。
    const OUTSIDE = join(homedir(), 'AppData', 'Local', 'Temp', 'bridge-shim-perm-probe.txt');
    writeFileSync(OUTSIDE, 'probe-ok\n');
    const outsidePosix = OUTSIDE.replace(/\\/g, '/');
    const argv = [
      '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--permission-mode', 'default', '--permission-prompt-tool', 'stdio',
    ];
    const c = spawn('node', [SHIM, ...argv], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: c.stdout, crlfDelay: Infinity });
    const send = (o) => c.stdin.write(JSON.stringify(o) + '\n');
    let asked = 0;
    let modeAnswered = false;
    let results = 0;
    c.on('spawn', () => {
      send({ type: 'control_request', request_id: 'a-init', request: { type: 'initialize' } });
      setTimeout(() => send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `Use the Read tool on ${outsidePosix} and report exact content. Do not use bash.` }] } }), 700);
    });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
        asked++;
        ok(msg.request.tool_name === 'Read', `can_use_tool 冒到宿主 (tool=${msg.request.tool_name})`);
        send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { behavior: 'allow', updatedInput: msg.request.input ?? {} } } });
      } else if (msg.type === 'control_response' && msg.response?.request_id === 'a-mode') {
        modeAnswered = true;
        ok(msg.response.subtype === 'success', `set_permission_mode 被 claude 接受 (subtype=${msg.response.subtype})`);
        ok(msg.response.response?.mode === 'plan', `claude 回执 mode=${msg.response.response?.mode}`);
      } else if (msg.type === 'result') {
        results++;
        ok(!msg.is_error, `审批后 result#${results} is_error=false`);
        if (results === 1) {
          // 用 plan：无需 --allow-dangerously-skip-permissions 就能被 claude 接受，
          // 能干净地证明「转发 + 回执」这条链路通。bypassPermissions 在未带该启动
          // 参数时会被 claude 明确拒绝（已实测），那是 App 侧「完全访问」走
          // canUseTool 自动批准、而非切模式的原因。
          send({ type: 'control_request', request_id: 'a-mode', request: { subtype: 'set_permission_mode', mode: 'plan' } });
          setTimeout(() => c.stdin.end(), 4000);
        }
      }
    });
    c.on('exit', () => {
      ok(asked >= 1, `宿主收到 can_use_tool 请求 (got ${asked})`);
      ok(modeAnswered, 'set_permission_mode 有 control_response 回给宿主');
      try { rmSync(OUTSIDE, { force: true }); } catch {}
      resolve();
    });
  });
}

await runInternalDriven();
await runSessionDriven();
await runApprovalRelay();
console.log(`\n===== 结果: ${failures === 0 ? '全部通过 🐾' : failures + ' 项失败'} =====`);
process.exit(failures === 0 ? 0 : 1);
