import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverLocalAgents, executeLocalAgent, LocalAgentError, LOCAL_AGENT_IDS } from './local-agents.mjs';

const SECRET = 'SYNTHETIC_PRIVATE_VALUE_NEVER_RETURN_479';
const FAKE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const id = path.basename(process.argv[1]), args = process.argv.slice(2);
const fixture = JSON.parse(process.env.LOCAL_AGENT_FIXTURE || '{}');
const mode = fixture.mode || 'success';
const secret = 'SYNTHETIC_PRIVATE_VALUE_NEVER_RETURN_479';
const write = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
const later = (fn) => setTimeout(fn, fixture.probeDelayMs || 0);
if (args[0] === '--version') later(() => {
  if (mode === 'probe-overflow') return write('x'.repeat(90000));
  write('Synthetic ' + id + ' ' + (fixture.version || '2.1.123') + '\n' + secret); process.exitCode = 0;
});
else if (args[0] === 'app-server') {
  let pending = '', initialized = false; process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    pending += chunk; let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      const c = JSON.parse(line);
      if (!['initialize','initialized','account/rateLimits/read'].includes(c.method)) throw new Error('Unexpected metadata method');
      if (c.method === 'initialize') write(JSON.stringify({id:c.id,result:{serverInfo:'synthetic'}}) + '\n');
      if (c.method === 'initialized') initialized = true;
      if (c.method === 'account/rateLimits/read') {
        if (!initialized) throw new Error('Missing initialized notification');
        if (fixture.quotaMode === 'timeout') { setInterval(() => {},1000); return; }
        if (fixture.quotaMode === 'error') { write(JSON.stringify({id:c.id,error:{message:secret}}) + '\n'); return; }
        write(JSON.stringify({id:c.id,result:{accountId:secret,rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:1800000000},credits:{balance:'12.50',unlimited:false}}}}) + '\n');
      }
    }
  });
}
else if (args.includes('rpc')) { process.stdin.setEncoding('utf8'); process.stdin.on('data', line => { const c = JSON.parse(line); write(JSON.stringify({ id:c.id, success:true, data:{models:[{provider:'synthetic',id:'model-a',reasoning:true}]} }) + '\n'); }); }
else if (args[0] === 'mcp' && args[1] === 'list') write([{name:'unrelated-service',enabled:true},...(args.includes('--disable') && args.includes('apps') ? [] : [{name:'codex_app',enabled:true}])]);
else if (args[0] === 'features' && args[1] === 'list') write(mode === 'missing-tool-control' ? 'shell_tool stable true' : 'apps browser_use browser_use_external computer_use view_image shell_tool unified_exec multi_agent plugins remote_plugin code_mode_host in_app_browser memories hooks skill_search skip_host_skill_discovery');
else if (args[0] === 'exec' && args.includes('--help')) write('--ignore-user-config --ignore-rules');
else if ((args[0] === 'login' || args[0] === 'auth') && args[1] === 'status') later(() => {
  if (mode === 'auth-timeout') { setInterval(() => {}, 1000); return; }
  if (id === 'codex') {
    process.stderr.write(mode === 'logged-out' ? 'Not logged in\n' + secret : 'Logged in ' + secret);
    process.exitCode = mode === 'logged-out' ? 1 : 0;
  } else {
    if (mode === 'malformed-auth') return write('not JSON ' + secret);
    write({ loggedIn: mode !== 'logged-out', authMethod: mode === 'malicious-auth' ? '<img src=' + secret + '>' : 'claude.ai', email: secret, accessToken: secret, accountId: secret });
    process.exitCode = mode === 'logged-out' ? 1 : 0;
  }
});
else if (args[0] === '--help') {
  setTimeout(() => write(mode === 'old-cli' ? '--print --output-format' : '--safe-mode --print --input-format --output-format --tools --strict-mcp-config --mcp-config --allowedTools --disallowedTools --permission-mode --disable-slash-commands --no-session-persistence --settings'), fixture.helpDelayMs || 0);
} else {
  let input = '';
  process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    fs.writeFileSync(process.env.LOCAL_AGENT_TRACE, JSON.stringify({ args, input, cwd: process.cwd(), pid: process.pid }));
    if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
    if (mode === 'overflow') return write('x'.repeat(100000));
    if (mode === 'quota') { process.stderr.write('429 quota exceeded ' + secret); process.exitCode = 1; return; }
    if (mode === 'malicious-output') { write(JSON.stringify({ type: 'tool_result', text: secret })); process.stderr.write(secret); return; }
    const done = () => {
      if (id === 'claude') write({ type: 'result', subtype: 'success', is_error: mode === 'failed-event', result: '# 合成文档\n\nActual fixture result.' });
      else {
        write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '# 合成文档\n\nActual fixture result.' } }) + '\n');
        if (mode !== 'incomplete') write(JSON.stringify({ type: mode === 'failed-event' ? 'turn.failed' : 'turn.completed' }) + '\n');
      }
    };
    if (mode === 'delayed') setTimeout(done, 110); else done();
  });
}
`;

async function fixture(t, value = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-local-agent-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin'), workspace = join(directory, 'work');
  await mkdir(bin); await mkdir(workspace);
  const commands = {};
  for (const id of LOCAL_AGENT_IDS) {
    const path = join(bin, id);
    await writeFile(path, `#!${process.execPath}\n${FAKE}`, { mode: 0o700 }); commands[id] = path;
  }
  const trace = join(directory, 'trace.json');
  const calls = [], closed = new Set(); let active = 0, maximum = 0;
  const deps = {
    home: directory, commands, env: { ...process.env, PATH: bin, LOCAL_AGENT_FIXTURE: JSON.stringify(value), LOCAL_AGENT_TRACE: trace },
    spawn(command, args, options) {
      calls.push({ command, args, options }); active++; maximum = Math.max(active, maximum);
      // Execute synthetic scripts with the trusted interpreter. Fresh executable
      // shebang files can spend >3s in macOS launch checks before Node even starts;
      // that is unrelated to the adapter's bounded protocol probe being tested.
      const child = spawn(process.execPath, [command, ...args], { ...options, env: { ...options.env, LOCAL_AGENT_TRACE: trace, LOCAL_AGENT_FIXTURE: deps.env.LOCAL_AGENT_FIXTURE } });
      child.once('close', () => { active--; if (child.pid) closed.add(child.pid); }); return child;
    },
  };
  return { directory, bin, workspace, trace, deps, calls, closed, maxActive: () => maximum,
    setMode(mode) { deps.env.LOCAL_AGENT_FIXTURE = JSON.stringify({ ...value, mode }); },
    async execute(id = 'codex', more = {}) { return executeLocalAgent({ id, prompt: 'Only this synthetic prompt; $(not a shell command)', workspace, deps, ...more }); } };
}

function safeError(code) {
  return error => error instanceof LocalAgentError && error.code === code && !JSON.stringify(error).includes(SECRET) && !error.message.includes(SECRET);
}

test('native tool mode disables inherited capabilities and passes the scoped credential only through child environment', async t => {
  const f = await fixture(t);
  const token = 'SYNTHETIC_SCOPED_SESSION_NEVER_IN_ARGUMENTS';
  const result = await f.execute('codex', { toolSession: { endpoint: 'http://127.0.0.1:12345/s/abcdef', token } });
  const call = f.calls.find(item => item.args[0] === 'exec');
  // Codex's -c key parser treats quotes as literal name characters, unlike TOML tables.
  assert.ok(call.args.some(arg => arg === 'mcp_servers.unrelated-service.enabled=false'));
  assert.ok(!call.args.some(arg => arg.startsWith('mcp_servers.codex_app.')));
  assert.ok(call.args.includes('shell_tool')); assert.ok(call.args.includes('apps'));
  assert.ok(!call.args.includes('code_mode_host'), 'the scoped MCP router must remain available');
  assert.ok(call.args.includes('mcp_servers.agentroom.default_tools_approval_mode="approve"'));
  assert.equal(call.options.env.AGENTROOM_TOOL_TOKEN, token);
  assert.ok(!JSON.stringify(call.args).includes(token)); assert.ok(!JSON.stringify(result).includes(token));
});

test('unsupported native tool control fails before execution instead of falling back to unrestricted chat', async t => {
  const f = await fixture(t, { mode: 'missing-tool-control' });
  await assert.rejects(f.execute('codex', { toolSession: { endpoint: 'http://127.0.0.1:12345/s/abcdef', token: 'synthetic' } }), safeError('unsupported_cli_version'));
  assert.ok(!f.calls.some(item => item.args[0] === 'exec'));
});
test('guest mode discards user customization and private environment while retaining exact model and auth home', async t => {
  const f = await fixture(t, { version: '0.163.0' }); f.deps.env.PRIVATE_OWNER_CONTEXT = SECRET;
  await f.execute('codex', { isolateUserContext: true, executionSnapshot: { model: 'model-a', provider: 'openai', thinking: 'medium' }, toolSession: { endpoint: 'http://127.0.0.1:12345/s/abcdef', token: 'synthetic' } });
  const call = f.calls.find(item => item.args[0] === 'exec' && !item.args.includes('--help'));
  assert.ok(call.args.includes('--ignore-user-config')); assert.ok(call.args.includes('--ignore-rules'));
  for (const name of ['memories', 'hooks', 'skill_search']) assert.ok(call.args.some((x, i) => x === '--disable' && call.args[i + 1] === name));
  assert.ok(call.args.some((x, i) => x === '--enable' && call.args[i + 1] === 'skip_host_skill_discovery'));
  assert.ok(call.args.includes('skills.include_instructions=false')); assert.ok(call.args.includes('--strict-config'));
  assert.equal(call.options.env.PRIVATE_OWNER_CONTEXT, undefined);
  assert.ok(call.args.includes('model-a'));
});
async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Synthetic condition did not arrive');
    await delay(5);
  }
}

test('discovery awaits subprocess close, bounds concurrency, deduplicates and caches only safe public records', async t => {
  const f = await fixture(t, { probeDelayMs: 25 }); let now = 1000; f.deps.now = () => now;
  const [a, b] = await Promise.all([discoverLocalAgents({ deps: f.deps }), discoverLocalAgents({ deps: f.deps })]);
  assert.equal(f.calls.length, 9); assert.ok(f.maxActive() <= 2); assert.equal(f.closed.size, 9);
  assert.deepEqual(a, b); assert.equal(a.agents.length, 5);
  assert.equal(a.agents[0].quota.status, 'available');
  assert.equal(a.agents[0].quota.windows[0].remainingPercent, 75);
  assert.equal(a.agents[0].quota.credits.balance, '12.50');
  assert.equal(a.agents[0].quota.checkedAt, new Date(now).toISOString());
  assert.equal(a.agents[0].version, '2.1.123'); assert.equal(a.agents[0].auth.status, 'configured');
  assert.deepEqual(a.agents[1].auth, { status: 'configured', method: 'claude.ai' });
  assert.equal(a.agents.find(x => x.id === 'pi').execution.supported, true);
  assert.ok(!JSON.stringify(a).includes(SECRET)); assert.ok(!JSON.stringify(a).includes(f.directory));
  assert.ok(!JSON.stringify(a).includes('email')); assert.ok(!JSON.stringify(a).includes('accessToken'));
  for (const { args, options } of f.calls) {
    assert.equal(options.shell, false);
    assert.ok(args[0] === '--version' || ['login', 'auth', '--mode', 'app-server'].includes(args[0]));
    assert.notDeepEqual(args, ['auth', 'status', '--json']);
  }
  a.agents[0].name = 'mutated';
  assert.equal((await discoverLocalAgents({ deps: f.deps })).agents[0].name, 'Codex'); assert.equal(f.calls.length, 9);
  await discoverLocalAgents({ force: true, deps: f.deps }); assert.equal(f.calls.length, 17);
  now += 16_000; await discoverLocalAgents({ deps: f.deps }); assert.equal(f.calls.length, 25);
  now += 61_000; await discoverLocalAgents({ deps: f.deps }); assert.equal(f.calls.length, 34);
});

test('missing trusted override never falls back to the host CLI; common user bin search needs no shell', async t => {
  const f = await fixture(t);
  for (const id of LOCAL_AGENT_IDS) f.deps.commands[id] = join(f.directory, `missing-${id}`);
  const absent = await discoverLocalAgents({ deps: f.deps });
  assert.ok(absent.agents.every(x => !x.installed && x.version === null && x.setupUrl.startsWith('https://')));
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.execute(), safeError('not_installed'));
  const local = join(f.directory, '.local/bin'); await mkdir(local, { recursive: true });
  await rm(join(f.bin, 'codex'));
  await writeFile(join(local, 'codex'), `#!${process.execPath}\n${FAKE}`, { mode: 0o700 });
  delete f.deps.commands.codex;
  assert.equal((await discoverLocalAgents({ force: true, deps: f.deps })).agents[0].installed, true);
  assert.equal(f.calls[0].command, join(local, 'codex'));
});

for (const quotaMode of ['error', 'timeout']) test(`quota ${quotaMode} preserves model metadata and reaps its owned probe`, async t => {
  const f = await fixture(t, { quotaMode }); f.deps.probeTimeoutMs = 300;
  const result = await discoverLocalAgents({ deps: f.deps });
  const codex = result.agents.find(agent => agent.id === 'codex');
  assert.equal(codex.quota.status, 'unavailable'); assert.equal(codex.quota.reason, 'read_failed');
  assert.equal(codex.auth.status, 'configured');
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal(f.closed.size, f.calls.length); assert.ok(f.maxActive() <= 2);
});

test('version failure and authentication remain separate; malformed/overflow output never becomes auth or text', async t => {
  const f = await fixture(t, { mode: 'probe-overflow' });
  const state = await discoverLocalAgents({ deps: f.deps });
  assert.equal(state.agents[0].installed, true); assert.equal(state.agents[0].version, null);
  assert.equal(state.agents[0].auth.status, 'configured');
  f.setMode('malformed-auth');
  assert.equal((await discoverLocalAgents({ force: true, deps: f.deps })).agents[1].auth.status, 'unknown');
  await assert.rejects(f.execute('claude'), safeError('authentication_unknown'));
  assert.ok(!JSON.stringify(state).includes(SECRET));
});

test('Claude auth exports only loggedIn meaning and a fixed authMethod enum', async t => {
  const f = await fixture(t, { mode: 'malicious-auth' });
  const state = await discoverLocalAgents({ deps: f.deps });
  assert.deepEqual(state.agents[1].auth, { status: 'configured' });
  assert.ok(!JSON.stringify(state).includes(SECRET));
});

test('both logged-out agents stop before a prompt or login invocation', async t => {
  const f = await fixture(t, { mode: 'logged-out' });
  for (const id of ['codex', 'claude']) await assert.rejects(f.execute(id), safeError('authentication_required'));
  await assert.rejects(access(f.trace));
  assert.ok(f.calls.every(x => x.args[1] === 'status'));
});

test('Codex execution sends stdin without shell, awaits real completion, and parses only assistant plus completed-turn events', async t => {
  const f = await fixture(t, { mode: 'delayed' }), events = [], start = Date.now();
  const result = await f.execute('codex', { onEvent: event => events.push(event) });
  assert.ok(Date.now() - start >= 100); assert.equal(result.markdown, '# 合成文档\n\nActual fixture result.');
  assert.deepEqual(result.identity, { id: 'codex', name: 'Codex', version: '2.1.123', authentication: 'configured' });
  assert.equal(result.verification.externalEffectsVerified, false);
  const trace = JSON.parse(await readFile(f.trace));
  assert.equal(trace.input, 'Only this synthetic prompt; $(not a shell command)'); assert.equal(trace.cwd, await realpath(f.workspace));
  assert.deepEqual(trace.args, ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', f.workspace, '-']);
  assert.deepEqual(events, [{ type: 'started', agentId: 'codex' }, { type: 'progress', agentId: 'codex', phase: 'writing', text: result.markdown }, { type: 'completed', agentId: 'codex' }]);
  assert.ok(f.closed.has(trace.pid)); assert.equal(f.calls.at(-1).options.detached, process.platform !== 'win32');
});

test('Claude uses fixed no-tool/no-MCP noninteractive options without a model/provider override', async t => {
  const f = await fixture(t);
  const result = await f.execute('claude'); const { args, input } = JSON.parse(await readFile(f.trace));
  assert.equal(result.identity.authMethod, 'claude.ai'); assert.match(result.markdown, /Actual fixture result/);
  for (const flag of ['--safe-mode', '--print', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'mcp__*');
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.ok(!args.some(x => /bypass|dangerously|fallback|--model|--provider/.test(x)));
  assert.ok(input.includes('synthetic prompt'));
});

test('old Claude without required safety flags fails before any model invocation', async t => {
  const f = await fixture(t, { mode: 'old-cli' });
  await assert.rejects(f.execute('claude'), safeError('unsupported_cli_version'));
  await assert.rejects(access(f.trace));
});

test('Claude broker exposes only the scoped AgentRoom MCP without builtin tools or credentials in arguments', async t => {
  const f = await fixture(t);
  await f.execute('claude', { toolSession: { endpoint: 'http://127.0.0.1:12345/s/abcdef', token: 'synthetic-session-secret', toolNames: ['mcp_search', 'mcp_request'] } });
  const { args } = JSON.parse(await readFile(f.trace));
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ['agentroom']);
  assert.equal(args.includes('--safe-mode'), false, 'safe-mode disables even the explicitly supplied MCP server');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__agentroom__mcp_search,mcp__agentroom__mcp_request');
  assert.equal(args.includes('--disallowedTools'), false);
  assert.ok(!JSON.stringify(args).includes('synthetic-session-secret'));
  assert.ok(!JSON.stringify(config).includes('synthetic-session-secret'));
  assert.match(config.mcpServers.agentroom.args[0], /agentroom-tool-proxy\.mjs$/);
});

test('malicious, incomplete, and failed structured output cannot turn stderr or tool results into a report', async t => {
  const f = await fixture(t);
  for (const mode of ['malicious-output', 'failed-event', 'incomplete']) {
    f.setMode(mode);
    await assert.rejects(f.execute('codex'), safeError('execution_failed'));
  }
  f.setMode('failed-event'); await assert.rejects(f.execute('claude'), safeError('execution_failed'));
  f.setMode('quota'); await assert.rejects(f.execute(), safeError('provider_limit'));
});

test('oversized execution output stops its own child and never resolves as Markdown', async t => {
  const f = await fixture(t, { mode: 'overflow' }); f.deps.maxOutputBytes = 1024;
  await assert.rejects(f.execute(), safeError('output_limit'));
  const trace = JSON.parse(await readFile(f.trace)); assert.ok(f.closed.has(trace.pid));
});

test('execution timeout signals only its detached process group, escalates and awaits close', async t => {
  const f = await fixture(t, { mode: 'hang' });
  f.deps.executionTimeoutMs = 180; f.deps.killGraceMs = 20;
  const signals = [];
  f.deps.kill = (pid, kind) => { signals.push({ pid, kind }); return process.kill(pid, kind); };
  await assert.rejects(f.execute(), safeError('timeout'));
  const trace = JSON.parse(await readFile(f.trace));
  assert.deepEqual(signals.map(x => x.pid), [-trace.pid, -trace.pid]);
  assert.deepEqual(signals.map(x => x.kind), ['SIGTERM', 'SIGKILL']); assert.ok(f.closed.has(trace.pid));
});

test('cancellation before start spawns nothing; cancellation during execution awaits its own child exit', async t => {
  const f = await fixture(t, { mode: 'hang' });
  const before = new AbortController(); before.abort();
  await assert.rejects(f.execute('codex', { signal: before.signal }), safeError('cancelled')); assert.equal(f.calls.length, 0);
  const active = new AbortController();
  const execution = f.execute('codex', { signal: active.signal });
  await until(async () => { try { return Number.isInteger(JSON.parse(await readFile(f.trace)).pid); } catch { return false; } });
  active.abort(); await assert.rejects(execution, safeError('cancelled'));
  const trace = JSON.parse(await readFile(f.trace)); assert.ok(f.closed.has(trace.pid));
});

test('authentication probes have bounded time and unknown state, with no automatic login', async t => {
  const f = await fixture(t, { mode: 'auth-timeout' }); f.deps.probeTimeoutMs = 75; f.deps.killGraceMs = 20;
  const start = Date.now(); const state = await discoverLocalAgents({ deps: f.deps });
  assert.ok(Date.now() - start < 3000);
  assert.equal(state.agents[1].auth.status, 'unknown');
  assert.ok(f.calls.every(x => ['--version', 'auth', 'login', '--mode'].includes(x.args[0])));
  assert.ok(f.calls.filter(x => x.args[0] === 'auth' || x.args[0] === 'login').every(x => x.args[1] === 'status'));
});

test('fixed IDs and unsupported adapters cannot supply executables or arguments', async t => {
  const f = await fixture(t);
  for (const id of ['gemini', 'opencode']) await assert.rejects(f.execute(id), safeError('execution_unsupported'));
  await assert.rejects(f.execute('claude; touch injected'), safeError('unknown_agent'));
  await assert.rejects(f.execute('codex', { workspace: 'relative' }), safeError('invalid_input'));
  await assert.rejects(f.execute('codex', { prompt: '' }), safeError('invalid_input'));
  assert.equal(f.calls.length, 0);
});

test('spawn failures remain safe errors without leaking native stderr or executable paths', async t => {
  const f = await fixture(t);
  f.deps.spawn = () => { throw new Error(SECRET + f.directory); };
  const state = await discoverLocalAgents({ deps: f.deps });
  assert.equal(state.agents[0].installed, true); assert.equal(state.agents[0].auth.status, 'unknown');
  await assert.rejects(f.execute(), safeError('authentication_unknown'));
  assert.ok(!JSON.stringify(state).includes(SECRET));
});

test('a slow but bounded CLI help probe is not mistaken for an unsupported version', async t => {
  const f = await fixture(t, { helpDelayMs: 3000 });
  const result = await f.execute('claude'); assert.match(result.markdown, /Actual fixture result/);
});
