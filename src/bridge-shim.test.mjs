// bridge-shim.test.mjs — 模拟 SDK 调用 bridge-shim.mjs 的完整流程（内部查询 + 真实会话多轮）
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SHIM = 'C:\\Users\\xrl\\Documents\\Repos\\clauded-qwenwork\\bridge\\bridge-shim.mjs';
const CWD = 'C:\\Users\\xrl\\Documents\\Repos\\clauded-qwenwork\\bridge';

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

await runInternalDriven();
await runSessionDriven();
console.log(`\n===== 结果: ${failures === 0 ? '全部通过 🐾' : failures + ' 项失败'} =====`);
process.exit(failures === 0 ? 0 : 1);
