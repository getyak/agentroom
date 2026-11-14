import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createPersonalServer } from './index.mjs';
import { PersonalStore, digest } from './store.mjs';
import { Messenger } from './messenger.mjs';

let serial = 0;
const clientId = () => `test-request-${++serial}`;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-personal-test-'));
  const changes = new EventEmitter();
  let app;
  const launch = async () => {
    app = await createPersonalServer({ dataDir: directory, port: 0, remotePollMs: 5, ...options, onChange: (event) => changes.emit('change', event) });
    await app.listen(); return app;
  };
  await launch();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, get app() { return app; },
    async restart() { await app.close(); await launch(); },
    async api(path, body, method = body ? 'POST' : 'GET', headers = {}) {
      const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text, headers: response.headers };
    },
    wait(threadId, predicate, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const thread = app.store.get('thread', threadId);
          if (thread && predicate(thread)) { cleanup(); resolve(thread); }
        };
        const cleanup = () => { clearTimeout(timer); changes.off('change', check); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out: ${JSON.stringify(app.store.get('thread', threadId))}`)); }, timeoutMs);
        changes.on('change', check); check();
      });
    },
  };
}

async function remote(t, handler) {
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    try { await handler(message, response, request); }
    catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/rpc`, server };
}

const rpcReply = (response, message, result) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
};

async function controlledCodex(t) {
  const calls = [], events = new EventEmitter();
  const gate = await remote(t, (message, response) => { calls.push({ input: message.input, response }); events.emit('call'); });
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-controlled-codex-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'cli.mjs');
  await writeFile(script, `let input='';for await(const chunk of process.stdin) input+=chunk;const response=await fetch(${JSON.stringify(gate.url)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input})});const {result}=await response.json();console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result}}));console.log(JSON.stringify({type:'turn.completed'}));`);
  return {
    options: { codexCommand: process.execPath, codexArgs: [script] }, calls,
    async wait(index) {
      if (calls[index]) return calls[index];
      return new Promise((resolve, reject) => {
        const check = () => { if (calls[index]) { cleanup(); resolve(calls[index]); } };
        const cleanup = () => { clearTimeout(timer); events.off('call', check); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Missing subprocess call ${index}`)); }, 5000);
        events.on('call', check); check();
      });
    },
    release(index, result) {
      calls[index].response.writeHead(200, { 'Content-Type': 'application/json' });
      calls[index].response.end(JSON.stringify({ result }));
    },
  };
}

async function approvedRemote(f, url) {
  const connection = await f.api('/api/connections', { name: 'Owned agent', type: 'a2a', url, clientId: clientId() });
  assert.equal(connection.status, 201);
  const created = await f.api('/api/threads', { text: '整理本次上传内容', mode: 'connection', connectionId: connection.body.id, clientId: clientId(), attachments: [{ name: 'notes.txt', text: 'Only the selected source.' }] });
  const pending = await f.wait(created.body.id, (thread) => thread.status === 'needs_input');
  const decision = pending.decisions[0];
  const approved = await f.api(`/api/decisions/${decision.id}`, { choice: 'approve', version: decision.version, clientId: clientId() });
  assert.equal(approved.status, 200);
  return { threadId: created.body.id, decision };
}

test('large group directories do not block ordinary A2A chat with an automatic metadata payload', async t => {
  const received = [];
  const peer = await remote(t, (message, response) => {
    assert.ok(['message/send', 'tasks/get'].includes(message.method));
    if (message.method === 'message/send') received.push(JSON.parse(message.params.message.parts[0].text));
    return rpcReply(response, message, { kind: 'task', id: 'large-directory-reply', status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: '你好，消息已收到。' }] }] });
  });
  const f = await fixture(t, { assistantManager: false, discoverLocalAgents: async () => ({ agents: [] }) });
  const createdConnection = await f.api('/api/connections', { name: '目录远端伙伴', type: 'a2a', url: peer.url, clientId: clientId() }); assert.equal(createdConnection.status, 201);
  const connection = createdConnection.body;
  const createdActor = await f.api('/api/contacts', { kind: 'agent', name: '远端伙伴', handle: 'directory-remote', binding: { type: 'connection', connectionId: connection.id }, clientId: clientId() }); assert.equal(createdActor.status, 201);
  const actor = createdActor.body;
  const messenger = new Messenger(f.app.store), members = [];
  for (let i = 0; i < 29; i++) {
    const id = `directory-member-${i}`; members.push(id);
    f.app.store.put('contact', { id, name: '成'.repeat(78), handle: `member-${i}`, kind: 'agent', version: 1 });
  }
  for (let i = 0; i < 20; i++) messenger.createChat({ kind: 'group', title: `大型目录-${i}`, memberIds: members });
  const createdChat = await f.api('/api/chats', { kind: 'direct', memberIds: [actor.id], clientId: clientId() }); assert.equal(createdChat.status, 201);
  const chat = createdChat.body;
  const sent = await f.api(`/api/threads/${chat.id}/messages`, { text: 'hi', clientId: clientId() }); assert.equal(sent.status, 200);
  const completed = await f.wait(chat.id, thread => thread.runs[0]?.status === 'completed');
  assert.equal(received.length, 1); assert.equal(received[0].context.groupDirectory, undefined);
  assert.ok(JSON.stringify(received[0]).length < 100000);
  assert.ok(received[0].agentroomTools.tools.some(tool => tool.name === 'list_rooms'));
  assert.equal(completed.runs[0].deliveryState, 'delivered');
});

test('local organization is real, durable, idempotent, and hash-verified', async (t) => {
  const f = await fixture(t);
  const request = { text: '整理这些资料', mode: 'local', clientId: clientId(), attachments: [{ name: 'input.txt', text: 'alpha\nbeta\nalpha' }] };
  const created = await f.api('/api/threads', request);
  assert.equal(created.status, 201);
  const done = await f.wait(created.body.id, (thread) => thread.status === 'completed');
  assert.equal(done.runs.length, 1); assert.equal(done.artifacts.length, 1);
  const repeated = await f.api('/api/threads', request);
  assert.equal(repeated.body.id, done.id);
  assert.equal(f.app.store.require('thread', done.id).runs.length, 1);
  assert.equal((await f.api('/api/threads', { ...request, text: 'different' })).status, 409);
  const artifact = await f.api(`/api/artifacts/${done.artifacts[0].id}`);
  assert.equal(artifact.body.sha256, digest(artifact.body.body));
  assert.match(artifact.body.body, /本机确定性程序/); assert.match(artifact.body.body, /重复的非空文本行：1/);
  const download = await f.api(`/api/artifacts/${artifact.body.id}/download`);
  assert.equal(download.body, artifact.body.body);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  await f.restart();
  assert.equal((await f.api(`/api/threads/${done.id}`)).body.status, 'completed');
  assert.equal((await f.api(`/api/artifacts/${artifact.body.id}`)).body.sha256, artifact.body.sha256);
  for (const name of ['personal.sqlite', 'personal.sqlite-wal', 'personal.sqlite-shm']) assert.equal((await stat(join(f.directory, name))).mode & 0o777, 0o600);
});

test('new messages continue one thread and a retry does not duplicate source attachments', async (t) => {
  const f = await fixture(t);
  const created = await f.api('/api/threads', { text: '整理', mode: 'local', clientId: clientId(), attachments: [{ name: 'one.txt', text: 'one' }] });
  const done = await f.wait(created.body.id, (thread) => thread.status === 'completed');
  const next = await f.api(`/api/threads/${done.id}/messages`, { text: '继续统计', mode: 'local', clientId: clientId() });
  assert.equal(next.status, 200);
  const final = await f.wait(done.id, (thread) => thread.runs.length === 2 && thread.status === 'completed');
  assert.equal(final.id, done.id); assert.equal(final.artifacts.length, 2);
  assert.equal(final.messages.filter((message) => message.role === 'user').length, 2);
});

test('Codex subprocess returns actual assistant output; only explicit memories and this thread enter stdin', async (t) => {
  const scriptDirectory = await mkdtemp(join(tmpdir(), 'agentstudio-codex-fixture-'));
  t.after(() => rm(scriptDirectory, { recursive: true, force: true }));
  const script = join(scriptDirectory, 'codex.mjs');
  const captured = join(scriptDirectory, 'input.json');
  await writeFile(script, `import {writeFileSync} from 'node:fs'; let s=''; for await (const c of process.stdin) s+=c; writeFileSync(${JSON.stringify(captured)},s); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'# Real subprocess output\\nEvidence from supplied text.'}})); console.log(JSON.stringify({type:'turn.completed'}));`);
  const f = await fixture(t, { codexCommand: process.execPath, codexArgs: [script] });
  const selected = await f.api('/api/memories', { text: 'SELECTED MEMORY', clientId: clientId() });
  await f.api('/api/memories', { text: 'UNSELECTED SECRET MEMORY', clientId: clientId() });
  const other = await f.api('/api/threads', { text: 'OTHER THREAD PRIVATE TEXT', mode: 'local', clientId: clientId() });
  await f.wait(other.body.id, (thread) => thread.status === 'completed');
  const created = await f.api('/api/threads', { text: 'CURRENT USER REQUEST', clientId: clientId(), memoryIds: [selected.body.id], attachments: [{ name: 'selected.md', text: 'OWNED SOURCE TEXT' }] });
  const done = await f.wait(created.body.id, (thread) => thread.status === 'completed');
  assert.equal(done.artifacts[0].source, 'codex');
  assert.match(done.messages.at(-1).text, /Real subprocess output/);
  const input = await readFile(captured, 'utf8');
  assert.match(input, /SELECTED MEMORY/); assert.match(input, /CURRENT USER REQUEST/);
  assert.doesNotMatch(input, /UNSELECTED SECRET MEMORY|OTHER THREAD PRIVATE TEXT/);
  const sourceId = done.messages[0].attachments[0].id;
  assert.ok(input.includes(`"id":"${sourceId}","citeAs":"#source-${sourceId}"`));
  assert.match(input, /cite it as a Markdown link/);
  assert.equal(done.runs[0].verification.scope, 'local_artifact_readback');
  assert.equal(done.runs[0].chosenExecutor, 'codex');
});

test('missing CLI and provider errors block without synthetic success or provider fallback', async (t) => {
  const f = await fixture(t, { codexCommand: '/definitely/missing/codex' });
  const created = await f.api('/api/threads', { text: 'real request', clientId: clientId() });
  const blocked = await f.wait(created.body.id, (thread) => thread.status === 'blocked');
  assert.match(blocked.summary, /未找到 Codex/); assert.equal(blocked.artifacts.length, 0);
  assert.equal(blocked.messages.filter((message) => message.role === 'assistant').length, 0);
  const retry = await f.api(`/api/threads/${blocked.id}/retry`, { clientId: clientId() });
  assert.equal(retry.status, 200);
  const retried = await f.wait(blocked.id, (thread) => thread.runs.length === 2 && thread.status === 'blocked');
  assert.equal(retried.messages.filter((message) => message.role === 'user').length, 1);
});

test('provider quota failure and incomplete Codex JSONL never create a successful artifact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-provider-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'failure.mjs');
  await writeFile(script, `for await (const c of process.stdin) {} console.log(JSON.stringify({type:'turn.failed',error:{message:'insufficient credits quota'}})); process.exitCode=1;`);
  const f = await fixture(t, { codexCommand: process.execPath, codexArgs: [script] });
  const created = await f.api('/api/threads', { text: 'Do the actual task', clientId: clientId() });
  const blocked = await f.wait(created.body.id, (thread) => thread.status === 'blocked');
  assert.match(blocked.summary, /额度|限制/); assert.equal(blocked.artifacts.length, 0);
  await writeFile(script, `for await (const c of process.stdin) {} console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Partial output is not proof of completion'}}));`);
  const incomplete = await f.api('/api/threads', { text: 'Another actual task', clientId: clientId() });
  const uncompleted = await f.wait(incomplete.body.id, (thread) => thread.status === 'blocked');
  assert.equal(uncompleted.artifacts.length, 0); assert.equal(uncompleted.runs[0].status, 'blocked');
});

test('cancelling a Codex run cannot save a late assistant result', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-cancel-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'slow.mjs');
  await writeFile(script, `process.on('SIGTERM',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Late cancelled output'}}));console.log(JSON.stringify({type:'turn.completed'}));process.exit(0)}); for await (const c of process.stdin) {} setInterval(()=>{},1000);`);
  const f = await fixture(t, { codexCommand: process.execPath, codexArgs: [script] });
  const created = await f.api('/api/threads', { text: 'A slow actual task', clientId: clientId() });
  await f.wait(created.body.id, (thread) => thread.status === 'running');
  const requested = (await f.api(`/api/threads/${created.body.id}/cancel`, { clientId: clientId() })).body;
  assert.equal(requested.runs[0].cancelPending, true);
  assert.equal(requested.status, 'running');
  await f.app.worker.promise;
  const cancelled = (await f.api(`/api/threads/${created.body.id}`)).body;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.artifacts.length, 0);
});

test('approval records, remote delivery, task execution, and artifact verification are separate', async (t) => {
  let sends = 0, reads = 0, release;
  const sent = new Promise((resolve) => { release = resolve; });
  const r = await remote(t, (message, response) => {
    if (message.method === 'message/send') {
      sends++; release();
      assert.match(message.params.message.parts[0].text, /Only the selected source/);
      rpcReply(response, message, { kind: 'task', id: 'remote-owned-task', status: { state: 'working' } });
    } else {
      assert.equal(message.method, 'tasks/get'); reads++;
      rpcReply(response, message, { kind: 'task', id: 'remote-owned-task', status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'Verified remote response.' }] }] });
    }
  });
  const f = await fixture(t);
  const connection = await f.api('/api/connections', { name: 'Remote', type: 'a2a', url: r.url });
  const create = await f.api('/api/threads', { text: 'send my source', mode: 'connection', connectionId: connection.body.id, clientId: clientId(), attachments: [{ name: 'selected', text: 'Only the selected source' }] });
  const pending = await f.wait(create.body.id, (thread) => thread.status === 'needs_input');
  assert.equal(sends, 0); assert.equal(pending.decisions[0].deliveryState, 'not_sent');
  assert.match(pending.decisions[0].preview, /message\/send/);
  const decision = pending.decisions[0];
  const key = clientId(), approval = { choice: 'approve', version: decision.version, clientId: key };
  const recorded = await f.api(`/api/decisions/${decision.id}`, approval);
  assert.equal(recorded.body.decisions[0].decision.choice, 'approve');
  assert.equal(recorded.body.decisions[0].deliveryState, 'not_sent');
  await sent;
  const done = await f.wait(create.body.id, (thread) => thread.status === 'completed');
  assert.equal(sends, 1); assert.equal(reads, 1); assert.equal(done.runs[0].externalTaskId, 'remote-owned-task');
  assert.equal(done.decisions[0].deliveryState, 'delivered'); assert.equal(done.decisions[0].actionState, 'completed');
  assert.equal(done.decisions[0].verificationState, 'verified');
  assert.equal(done.runs[0].remoteVerification.externalEffectsVerified, false);
  assert.equal((await f.api(`/api/decisions/${decision.id}`, approval)).status, 200);
  assert.equal(sends, 1);
  assert.equal((await f.api(`/api/decisions/${decision.id}`, { choice: 'reject', version: 1, clientId: clientId() })).status, 409);
});

test('cancellation stops local waiting and rejects late remote results', async (t) => {
  let pendingResponse, releaseRequest;
  const dispatched = new Promise((resolve) => { releaseRequest = resolve; });
  const r = await remote(t, (message, response) => {
    pendingResponse = { message, response }; releaseRequest();
  });
  const f = await fixture(t);
  const { threadId } = await approvedRemote(f, r.url);
  await dispatched;
  const cancelled = await f.api(`/api/threads/${threadId}/cancel`, { clientId: clientId() });
  assert.equal(cancelled.body.status, 'unknown');
  assert.equal(cancelled.body.runs[0].status, 'cancelled');
  rpcReply(pendingResponse.response, pendingResponse.message, { kind: 'message', parts: [{ kind: 'text', text: 'late response' }] });
  await f.app.worker.promise;
  const result = (await f.api(`/api/threads/${threadId}`)).body;
  assert.equal(result.status, 'unknown'); assert.equal(result.runs[0].status, 'cancelled'); assert.equal(result.artifacts.length, 0);
  assert.match(result.summary, /远端执行未获取消确认/);
  assert.equal((await f.api(`/api/threads/${threadId}/retry`, { clientId: clientId() })).status, 409);
});

test('unknown remote write is not replayed after restart; taskId reconciliation uses reads only', async (t) => {
  let sends = 0, complete = false, observedRead;
  const firstRead = new Promise((resolve) => { observedRead = resolve; });
  const r = await remote(t, (message, response) => {
    if (message.method === 'message/send') {
      sends++; rpcReply(response, message, { kind: 'task', id: 'durable-task', status: { state: 'working' } });
    } else {
      observedRead();
      rpcReply(response, message, complete ? { kind: 'task', id: 'durable-task', status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'Readback recovered.' }] }] } : { kind: 'task', id: 'durable-task', status: { state: 'working' } });
    }
  });
  const f = await fixture(t);
  const { threadId } = await approvedRemote(f, r.url);
  await firstRead;
  await f.restart();
  const unknown = (await f.api(`/api/threads/${threadId}`)).body;
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.runs[0].externalTaskId, 'durable-task'); assert.equal(sends, 1);
  complete = true;
  assert.equal((await f.api(`/api/threads/${threadId}/reconcile`, { clientId: clientId() })).status, 200);
  const recovered = await f.wait(threadId, (thread) => thread.status === 'completed');
  assert.equal(sends, 1); assert.match(recovered.messages.at(-1).text, /Readback recovered/);
});

test('recovery marks interrupted dispatch unknown, preserves queued work, and forbids double workers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-personal-recovery-'));
  const store = new PersonalStore(directory);
  const interrupted = store.createThread({ text: 'external write', mode: 'connection', connectionId: 'unavailable-connection' });
  const run = interrupted.runs[0]; run.status = 'running'; run.deliveryState = 'sending'; run.actionState = 'running'; interrupted.status = 'running';
  store.put('thread', interrupted);
  const queued = store.createThread({ text: 'persisted queue', mode: 'local' });
  assert.throws(() => new PersonalStore(directory), /already open/);
  store.close();
  const app = await createPersonalServer({ dataDir: directory, port: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.listen();
  assert.equal(app.store.require('thread', interrupted.id).status, 'unknown');
  assert.equal(app.store.require('thread', interrupted.id).runs[0].deliveryState, 'unknown');
  await app.worker.promise;
  assert.equal(app.store.require('thread', queued.id).status, 'completed');
});

test('remote failure cannot become completed, and a transport failure without taskId cannot retry', async (t) => {
  let mode = 'fail', sends = 0;
  const r = await remote(t, (message, response) => {
    if (message.method === 'message/send') {
      sends++;
      if (mode === 'disconnect') { response.destroy(); return; }
      rpcReply(response, message, { kind: 'task', id: 'failed-task', status: { state: 'working' } });
    } else rpcReply(response, message, { kind: 'task', id: 'failed-task', status: { state: 'failed' } });
  });
  const f = await fixture(t);
  const failed = await approvedRemote(f, r.url);
  const failure = await f.wait(failed.threadId, (thread) => thread.status === 'failed');
  assert.equal(failure.artifacts.length, 0); assert.equal(failure.decisions[0].actionState, 'failed');
  mode = 'disconnect';
  const disconnected = await approvedRemote(f, r.url);
  const unknown = await f.wait(disconnected.threadId, (thread) => thread.status === 'unknown');
  assert.equal(unknown.artifacts.length, 0);
  assert.equal((await f.api(`/api/threads/${disconnected.threadId}/retry`, { clientId: clientId() })).status, 409);
  await f.restart(); assert.equal(sends, 2);
});

test('MCP discovery performs the bounded handshake and does not call a tool', async (t) => {
  const methods = [];
  const r = await remote(t, (message, response, request) => {
    methods.push(message.method);
    if (message.method === 'initialize') rpcReply(response, message, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'owned-test', version: '1' } });
    else if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); }
    else { assert.equal(request.headers['mcp-protocol-version'], '2025-11-25'); rpcReply(response, message, { tools: [{ name: 'read_document', inputSchema: { type: 'object' } }] }); }
  });
  const f = await fixture(t);
  const connection = await f.api('/api/connections', { name: 'Owned MCP', url: r.url, type: 'mcp' });
  const discovery = await f.api(`/api/connections/${connection.body.id}/tools`);
  assert.equal(discovery.status, 200); assert.equal(discovery.body.supported, 'approved_tools_call');
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('MCP stateful SSE tool call waits for exact approval and verifies explicitly approved readback', async (t) => {
  let writes = 0, reads = 0, value = null;
  const r = await remote(t, (message, response, request) => {
    if (message.method === 'initialize') {
      response.setHeader('Mcp-Session-Id', 'owned-fake-session');
      return rpcReply(response, message, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'owned-fake', version: '1' } });
    }
    assert.equal(request.headers['mcp-session-id'], 'owned-fake-session');
    if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    if (message.method === 'tools/list') return rpcReply(response, message, { tools: [
      { name: 'write_value', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'read_value', inputSchema: { type: 'object' } },
    ] });
    assert.equal(message.method, 'tools/call');
    if (message.params.name === 'write_value') { writes++; value = message.params.arguments.value; }
    else { assert.equal(message.params.name, 'read_value'); reads++; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"working"}}\n\n');
    response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'Remote receipt' }], structuredContent: { value } } })}\n\n`);
    // Keep the HTTP stream open: the client must stop after its matching result.
    request.on('close', () => response.end());
  });
  const f = await fixture(t);
  const connection = await f.api('/api/connections', { name: 'MCP owned fake', type: 'mcp', url: r.url });
  assert.equal(connection.status, 201); assert.equal(connection.body.sessionId, undefined);
  const action = { toolName: 'write_value', arguments: { value: 'APPROVED EXACT VALUE' }, verification: {
    toolName: 'read_value', arguments: {}, expected: { path: '/structuredContent/value', equals: 'APPROVED EXACT VALUE' },
  } };
  const created = await f.api('/api/threads', { text: 'Set this owned test value', mode: 'connection', connectionId: connection.body.id, action, clientId: clientId() });
  const pending = await f.wait(created.body.id, (thread) => thread.status === 'needs_input');
  assert.equal(writes, 0); assert.match(pending.decisions[0].preview, /APPROVED EXACT VALUE/);
  assert.match(pending.decisions[0].preview, /read_value/);
  const approval = { choice: 'approve', version: 1, clientId: clientId() };
  assert.equal((await f.api(`/api/decisions/${pending.decisions[0].id}`, approval)).status, 200);
  const done = await f.wait(pending.id, (thread) => thread.status === 'completed');
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(done.artifacts[0].source, 'mcp');
  assert.equal(done.runs[0].externalVerification.externalEffectsVerified, true);
  assert.equal(done.runs[0].verification.scope, 'local_artifact_readback');
  assert.equal(done.runs[0].remoteReceipt.result.structuredContent.value, 'APPROVED EXACT VALUE');
  assert.equal(done.runs[0].remoteReceipt.readback.result.structuredContent.value, 'APPROVED EXACT VALUE');
  const readable = (await f.api(`/api/artifacts/${done.artifacts[0].id}`)).body.body;
  assert.match(readable, /Remote receipt/); assert.doesNotMatch(readable, /```json/);
  await f.api(`/api/decisions/${pending.decisions[0].id}`, approval);
  assert.equal(writes, 1);
});

test('MCP timeout after mutation is unknown and cannot be replayed; isError never completes', async (t) => {
  let calls = 0, disconnect = true;
  const r = await remote(t, (message, response) => {
    if (message.method === 'initialize') return rpcReply(response, message, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
    if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    if (message.method === 'tools/list') return rpcReply(response, message, { tools: [{ name: 'write', inputSchema: { type: 'object' } }] });
    calls++;
    if (disconnect) { response.destroy(); return; }
    rpcReply(response, message, { isError: true, content: [{ type: 'text', text: 'Refused by remote tool' }] });
  });
  const f = await fixture(t);
  const connection = await f.api('/api/connections', { name: 'MCP fake', type: 'mcp', url: r.url });
  const createApproved = async () => {
    const created = await f.api('/api/threads', { text: 'Explicit call', mode: 'connection', connectionId: connection.body.id, action: { toolName: 'write', arguments: { exact: 'value' } }, clientId: clientId() });
    const pending = await f.wait(created.body.id, (thread) => thread.status === 'needs_input');
    await f.api(`/api/decisions/${pending.decisions[0].id}`, { choice: 'approve', version: 1, clientId: clientId() });
    return pending.id;
  };
  const threadId = await createApproved();
  await f.wait(threadId, (thread) => thread.status === 'unknown');
  assert.equal((await f.api(`/api/threads/${threadId}/retry`, { clientId: clientId() })).status, 409);
  await f.restart(); assert.equal(calls, 1);
  disconnect = false;
  const errorId = await createApproved();
  const failed = await f.wait(errorId, (thread) => thread.status === 'failed');
  assert.equal(failed.decisions[0].actionState, 'failed'); assert.equal(calls, 2);
});

test('A2A readback cannot complete a different task or accept malformed task results', async (t) => {
  let resultKind = 'wrong-id';
  const r = await remote(t, (message, response) => {
    if (message.method === 'message/send') return rpcReply(response, message, { kind: 'task', id: 'TASK_A', status: { state: 'working' } });
    rpcReply(response, message, resultKind === 'wrong-id' ? { kind: 'task', id: 'TASK_B', status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'Wrong private task' }] }] } : { kind: 'message', id: 'TASK_A', status: { state: 'completed' } });
  });
  const f = await fixture(t);
  for (const mode of ['wrong-id', 'wrong-kind']) {
    resultKind = mode;
    const { threadId } = await approvedRemote(f, r.url);
    const unknown = await f.wait(threadId, (thread) => thread.status === 'unknown');
    assert.equal(unknown.artifacts.length, 0); assert.equal(unknown.runs[0].externalTaskId, 'TASK_A');
    assert.equal(unknown.messages.filter((message) => message.role === 'assistant').length, 0);
  }
});

test('replaying an old cancel cannot abort a subsequent run in the same thread', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-cancel-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'slow.mjs');
  await writeFile(script, `for await (const c of process.stdin) {} setInterval(()=>{},1000);`);
  const f = await fixture(t, { codexCommand: process.execPath, codexArgs: [script] });
  const created = await f.api('/api/threads', { text: 'slow request', clientId: clientId() });
  await f.wait(created.body.id, (thread) => thread.status === 'running');
  const cancel = { clientId: clientId() };
  await f.api(`/api/threads/${created.body.id}/cancel`, cancel);
  await f.app.worker.promise;
  await f.api(`/api/threads/${created.body.id}/retry`, { clientId: clientId() });
  const running = await f.wait(created.body.id, (thread) => thread.runs.length === 2 && thread.status === 'running');
  assert.notEqual(running.runs[0].id, running.runs[1].id);
  await f.api(`/api/threads/${created.body.id}/cancel`, cancel);
  assert.equal(f.app.worker.controller.signal.aborted, false);
  assert.equal(f.app.store.require('thread', created.body.id).status, 'running');
  await f.api(`/api/threads/${created.body.id}/cancel`, { clientId: clientId() });
  await f.app.worker.promise;
});

test('OS SQLite worker lock admits exactly one racing process and releases after a crash', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-worker-race-'));
  const children = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => once(child, 'exit'))); await rm(directory, { recursive: true, force: true }); });
  const script = `import {PersonalStore} from ${JSON.stringify(new URL('./store.mjs', import.meta.url).href)}; let store; process.on('message',()=>{try{store=new PersonalStore(process.argv[1]);process.send('acquired')}catch{process.send('busy')}});process.send('ready');`;
  for (let count = 0; count < 2; count++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(child); assert.equal((await once(child, 'message'))[0], 'ready');
  }
  const results = children.map((child) => once(child, 'message'));
  children.forEach((child) => child.send('open'));
  const states = (await Promise.all(results)).map(([state]) => state);
  assert.deepEqual([...states].sort(), ['acquired', 'busy']);
  const winner = children[states.indexOf('acquired')], loser = children[states.indexOf('busy')];
  const exited = once(winner, 'exit'); winner.kill('SIGKILL'); await exited;
  const retried = once(loser, 'message'); loser.send('open');
  assert.equal((await retried)[0], 'acquired');
});

test('same-process failed lock acquisition cannot release the live worker lock for another process', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-worker-lock-close-'));
  const store = new PersonalStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  assert.throws(() => new PersonalStore(directory), /already open/);
  const script = `import {PersonalStore} from ${JSON.stringify(new URL('./store.mjs', import.meta.url).href)};try{const s=new PersonalStore(process.argv[1]);s.close();process.exitCode=42}catch{process.exitCode=0}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, directory], { encoding: 'utf8', timeout: 3000 });
  assert.equal(child.status, 0, 'live owner must keep its lock after another in-process connection fails');
});

test('local artifact preserves every Markdown source byte, including long lines and later content', async (t) => {
  const f = await fixture(t);
  const original = `  leading whitespace\n# Original heading\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n\`\`\`js\nconst exact = true;\n\`\`\`\n${Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')}\n${'长'.repeat(700)}\n\n`;
  const created = await f.api('/api/threads', { text: '保留所有原文Markdown', mode: 'local', clientId: clientId(), attachments: [{ name: 'original.md', text: original }] });
  const done = await f.wait(created.body.id, (thread) => thread.status === 'completed');
  const artifact = (await f.api(`/api/artifacts/${done.artifacts[0].id}`)).body;
  assert.ok(artifact.body.includes(original)); assert.match(artifact.body, /line 19/);
  assert.equal(artifact.sha256, digest(artifact.body));
});

test('natural-language MCP planner produces a typed preview, asks for missing inputs, and rejects invented tools', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-mcp-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'planner.mjs');
  const setPlan = async (plan) => writeFile(script, `let input='';for await(const c of process.stdin)input+=c;console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(plan))}}}));console.log(JSON.stringify({type:'turn.completed'}));`);
  let calls = 0;
  const r = await remote(t, (message, response) => {
    if (message.method === 'initialize') return rpcReply(response, message, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
    if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    if (message.method === 'tools/list') return rpcReply(response, message, { tools: [{ name: 'write', inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } }, additionalProperties: false } }] });
    calls++; return rpcReply(response, message, { content: [{ type: 'text', text: 'Actual fake result' }] });
  });
  const f = await fixture(t, { codexCommand: process.execPath, codexArgs: [script] });
  const connection = await f.api('/api/connections', { name: 'Owned MCP', type: 'mcp', url: r.url });
  await setPlan({ toolName: 'write', arguments: { value: 'precise user value' } });
  const first = await f.api('/api/threads', { text: '设置我明确给出的值', mode: 'connection', connectionId: connection.body.id, clientId: clientId() });
  const pending = await f.wait(first.body.id, (thread) => thread.status === 'needs_input');
  assert.equal(pending.runs[0].plannedBy, 'codex'); assert.equal(calls, 0);
  assert.match(pending.decisions[0].preview, /precise user value/);
  await f.api(`/api/decisions/${pending.decisions[0].id}`, { choice: 'approve', version: 1, clientId: clientId() });
  const done = await f.wait(first.body.id, (thread) => thread.status === 'completed');
  assert.equal(calls, 1); assert.equal(done.decisions[0].verificationState, 'not_provided');
  await setPlan({ needsInput: true, question: '要设置哪个具体值？' });
  const missing = await f.api('/api/threads', { text: '设置一个值', mode: 'connection', connectionId: connection.body.id, clientId: clientId() });
  const question = await f.wait(missing.body.id, (thread) => thread.status === 'blocked');
  assert.match(question.summary, /哪个具体值/); assert.equal(question.decisions.length, 0);
  await setPlan({ toolName: 'invented_tool', arguments: {} });
  const bad = await f.api('/api/threads', { text: '执行', mode: 'connection', connectionId: connection.body.id, clientId: clientId() });
  const rejected = await f.wait(bad.body.id, (thread) => thread.status === 'blocked');
  assert.match(rejected.summary, /目录之外/); assert.equal(calls, 1);
});

test('automatic routing keeps document work local, asks precise questions, blocks bad plans, and approves A2A dispatch', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-auto-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'planner.mjs');
  const setPlan = async (plan) => writeFile(script, `for await(const c of process.stdin){}console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(typeof plan === 'string' ? plan : JSON.stringify(plan))}}}));console.log(JSON.stringify({type:'turn.completed'}));`);
  let sends = 0;
  const r = await remote(t, (message, response) => {
    if (message.method === 'message/send') { sends++; return rpcReply(response, message, { kind: 'task', id: 'auto-task', status: { state: 'working' } }); }
    return rpcReply(response, message, { kind: 'task', id: 'auto-task', status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'Actual remote response.' }] }] });
  });
  const f = await fixture(t, { codexCommand: process.execPath, codexArgs: [script] });
  const connection = await f.api('/api/connections', { name: '明确的远端助手', type: 'a2a', url: r.url });
  await setPlan({ kind: 'document', markdown: '# Actual local document\nUseful content.', why: '这是本机写作请求，不需要远端服务' });
  const local = await f.api('/api/threads', { text: '写一个文档', clientId: clientId() });
  const document = await f.wait(local.body.id, (thread) => thread.status === 'completed');
  assert.equal(document.runs[0].chosenExecutor, 'codex'); assert.equal(sends, 0); assert.equal(document.decisions.length, 0);
  await setPlan({ kind: 'needs_input', question: '请给出收件人的具体账号。', why: '缺少唯一目标' });
  const incomplete = await f.api('/api/threads', { text: '给那个人发送内容', clientId: clientId() });
  const question = await f.wait(incomplete.body.id, (thread) => thread.status === 'blocked');
  assert.match(question.summary, /具体账号/); assert.equal(sends, 0);
  await setPlan('not valid JSON');
  const bad = await f.api('/api/threads', { text: '一个任务', clientId: clientId() });
  const invalid = await f.wait(bad.body.id, (thread) => thread.status === 'blocked');
  assert.equal(invalid.artifacts.length, 0); assert.equal(sends, 0);
  await setPlan({ kind: 'a2a', connectionId: connection.body.id, why: '用户明确要求该远端助手处理本次内容' });
  const remoteTask = await f.api('/api/threads', { text: '请让明确的远端助手整理本次内容', clientId: clientId() });
  const pending = await f.wait(remoteTask.body.id, (thread) => thread.status === 'needs_input');
  assert.equal(sends, 0); assert.equal(pending.runs[0].requestedMode, 'codex'); assert.equal(pending.runs[0].chosenExecutor, 'a2a');
  await f.api(`/api/decisions/${pending.decisions[0].id}`, { choice: 'approve', version: 1, clientId: clientId() });
  await f.wait(pending.id, (thread) => thread.status === 'completed'); assert.equal(sends, 1);
});

test('automatic MCP routing requires approval before a catalog-selected tool can mutate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-auto-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'planner.mjs');
  let calls = 0;
  const r = await remote(t, (message, response) => {
    if (message.method === 'initialize') return rpcReply(response, message, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
    if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    if (message.method === 'tools/list') return rpcReply(response, message, { tools: [{ name: 'set', inputSchema: { type: 'object' } }] });
    calls++; return rpcReply(response, message, { content: [{ type: 'text', text: 'Actual call receipt' }] });
  });
  const f = await fixture(t, { codexCommand: process.execPath, codexArgs: [script] });
  const connection = await f.api('/api/connections', { name: 'Owned value store', type: 'mcp', url: r.url });
  const plan = { kind: 'mcp', connectionId: connection.body.id, action: { toolName: 'set', arguments: { key: 'owned-key', value: 'exact' } }, why: '该工具匹配用户明确给出的key和值' };
  await writeFile(script, `for await(const c of process.stdin){}console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(plan))}}}));console.log(JSON.stringify({type:'turn.completed'}));`);
  const created = await f.api('/api/threads', { text: '在Owned value store将owned-key设为exact', clientId: clientId() });
  const pending = await f.wait(created.body.id, (thread) => thread.status === 'needs_input');
  assert.equal(calls, 0); assert.equal(pending.runs[0].chosenExecutor, 'mcp'); assert.match(pending.decisions[0].preview, /owned-key/);
  await f.api(`/api/decisions/${pending.decisions[0].id}`, { choice: 'approve', version: 1, clientId: clientId() });
  const done = await f.wait(pending.id, (thread) => thread.status === 'completed');
  assert.equal(calls, 1); assert.equal(done.artifacts[0].source, 'mcp');
});

test('followup is durably queued during a slow CLI and runs sequentially without a browser subscription', async (t) => {
  const cli = await controlledCodex(t), f = await fixture(t, cli.options);
  const created = await f.api('/api/threads', { text: 'FIRST ORIGINAL REQUEST', clientId: clientId() });
  const first = await cli.wait(0);
  const queued = await f.api(`/api/threads/${created.body.id}/messages`, { text: 'FUTURE FOLLOWUP REQUEST', clientId: clientId(), attachments: [{ name: 'future.txt', text: 'FUTURE ATTACHMENT PRIVATE TEXT' }] });
  assert.equal(queued.status, 200); assert.equal(queued.body.runs.length, 2);
  assert.equal(queued.body.runs[0].status, 'running'); assert.equal(queued.body.runs[1].status, 'queued');
  assert.match(queued.body.summary, /补充已保存/);
  assert.doesNotMatch(first.input, /FUTURE FOLLOWUP REQUEST|FUTURE ATTACHMENT PRIVATE TEXT/);
  assert.equal(f.app.store.require('thread', created.body.id).messages.filter((message) => message.role === 'user').length, 2);
  // No SSE/browser session exists. Releasing the subprocess alone advances the durable worker.
  cli.release(0, '# First result');
  const second = await cli.wait(1);
  const between = f.app.store.require('thread', created.body.id);
  assert.equal(between.runs[0].status, 'completed'); assert.equal(between.artifacts.length, 1); assert.equal(between.runs[1].status, 'running');
  assert.match(second.input, /FUTURE FOLLOWUP REQUEST/); assert.match(second.input, /FUTURE ATTACHMENT PRIVATE TEXT/);
  cli.release(1, '# Followup result');
  const done = await f.wait(created.body.id, (thread) => thread.status === 'completed' && thread.artifacts.length === 2);
  assert.equal(cli.calls.length, 2); assert.deepEqual(done.runs.map((run) => run.status), ['completed', 'completed']);
  assert.equal(new Set(done.artifacts.map((artifact) => artifact.runId)).size, 2);
});

test('a run queued before a later message cannot inspect that future message when it eventually starts', async (t) => {
  const cli = await controlledCodex(t), f = await fixture(t, cli.options);
  await f.api('/api/threads', { text: 'BLOCK OTHER THREAD FIRST', clientId: clientId() });
  await cli.wait(0);
  const created = await f.api('/api/threads', { text: 'QUEUED ORIGINAL GOAL', clientId: clientId() });
  const followup = await f.api(`/api/threads/${created.body.id}/messages`, { text: 'LATER GOAL MUST NOT LEAK BACKWARD', clientId: clientId(), attachments: [{ name: 'later.txt', text: 'LATER SOURCE MUST NOT LEAK' }] });
  assert.equal(followup.body.runs.filter((run) => run.status === 'queued').length, 2);
  cli.release(0, '# Other thread done');
  const original = await cli.wait(1);
  assert.match(original.input, /QUEUED ORIGINAL GOAL/);
  assert.doesNotMatch(original.input, /LATER GOAL MUST NOT LEAK BACKWARD|LATER SOURCE MUST NOT LEAK/);
  cli.release(1, '# Original isolated result');
  const later = await cli.wait(2); assert.match(later.input, /LATER GOAL MUST NOT LEAK BACKWARD/);
  cli.release(2, '# Later isolated result');
  const done = await f.wait(created.body.id, (thread) => thread.status === 'completed' && thread.artifacts.length === 2);
  assert.equal(done.runs.length, 2);
});

test('cancel targets the running run while its queued followup proceeds, and replay cannot cancel the followup', async (t) => {
  const cli = await controlledCodex(t), f = await fixture(t, cli.options);
  const created = await f.api('/api/threads', { text: 'CANCEL THIS FIRST RUN', clientId: clientId() });
  await cli.wait(0);
  await f.api(`/api/threads/${created.body.id}/messages`, { text: 'KEEP THIS FOLLOWUP', clientId: clientId() });
  const cancellation = { clientId: clientId() };
  const cancelled = await f.api(`/api/threads/${created.body.id}/cancel`, cancellation);
  assert.equal(cancelled.body.runs[0].status, 'cancelled'); assert.equal(cancelled.body.runs[1].status, 'queued');
  const second = await cli.wait(1); assert.match(second.input, /KEEP THIS FOLLOWUP/);
  await f.api(`/api/threads/${created.body.id}/cancel`, cancellation);
  assert.equal(f.app.worker.controller.signal.aborted, false);
  cli.release(1, '# Kept followup result');
  const done = await f.wait(created.body.id, (thread) => thread.status === 'completed' && thread.artifacts.length === 1);
  assert.deepEqual(done.runs.map((run) => run.status), ['cancelled', 'completed']);
  assert.equal(done.artifacts[0].runId, done.runs[1].id);
});

test('a new message invalidates the pending approval and only the replacement preview can dispatch', async (t) => {
  let sends = 0;
  const r = await remote(t, (message, response) => {
    if (message.method === 'message/send') {
      sends++; assert.match(message.params.message.parts[0].text, /NEW AGREED REQUEST/);
      return rpcReply(response, message, { kind: 'task', id: 'replacement-task', status: { state: 'working' } });
    }
    return rpcReply(response, message, { kind: 'task', id: 'replacement-task', status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'Replacement result' }] }] });
  });
  const f = await fixture(t);
  const connection = await f.api('/api/connections', { name: 'Owned replacement agent', type: 'a2a', url: r.url });
  const created = await f.api('/api/threads', { text: 'OLD UNAPPROVED REQUEST', mode: 'connection', connectionId: connection.body.id, clientId: clientId() });
  const old = await f.wait(created.body.id, (thread) => thread.status === 'needs_input');
  const originalDecision = old.decisions[0];
  const updated = await f.api(`/api/threads/${old.id}/messages`, { text: 'NEW AGREED REQUEST', mode: 'connection', connectionId: connection.body.id, clientId: clientId() });
  assert.equal(updated.status, 200); assert.equal(updated.body.decisions[0].state, 'cancelled');
  assert.match(updated.body.decisions[0].cancellationReason, /用户补充/);
  const replacement = await f.wait(old.id, (thread) => thread.decisions.length === 2 && thread.status === 'needs_input');
  assert.equal(sends, 0);
  assert.equal((await f.api(`/api/decisions/${originalDecision.id}`, { choice: 'approve', version: 1, clientId: clientId() })).status, 409);
  assert.equal((await f.api(`/api/decisions/${originalDecision.id}`, { choice: 'approve', version: 2, clientId: clientId() })).status, 409);
  const current = replacement.decisions[1];
  await f.api(`/api/decisions/${current.id}`, { choice: 'approve', version: current.version, clientId: clientId() });
  const done = await f.wait(old.id, (thread) => thread.status === 'completed');
  assert.equal(sends, 1); assert.equal(done.artifacts.length, 1);
});

test('unknown remote execution holds saved followups across restart and blocks new submissions', async (t) => {
  let responseToDrop, dispatched;
  const sending = new Promise((resolve) => { dispatched = resolve; });
  let sends = 0;
  const r = await remote(t, (message, response) => { sends++; responseToDrop = response; dispatched(); });
  const f = await fixture(t);
  const { threadId } = await approvedRemote(f, r.url);
  await sending;
  const queued = await f.api(`/api/threads/${threadId}/messages`, { text: 'SAVED FOLLOWUP MUST WAIT', mode: 'local', clientId: clientId() });
  assert.equal(queued.status, 200); assert.equal(queued.body.runs[1].status, 'queued');
  responseToDrop.destroy();
  const unknown = await f.wait(threadId, (thread) => thread.status === 'unknown');
  await f.app.worker.promise;
  assert.equal(unknown.runs[1].status, 'queued'); assert.equal(unknown.artifacts.length, 0);
  assert.match(unknown.summary, /核查后再继续/);
  const newSubmission = await f.api(`/api/threads/${threadId}/messages`, { text: 'DO NOT RESUBMIT UNKNOWN', mode: 'local', clientId: clientId() });
  assert.equal(newSubmission.status, 409);
  await f.restart();
  const recovered = (await f.api(`/api/threads/${threadId}`)).body;
  assert.equal(recovered.status, 'unknown'); assert.equal(recovered.runs[1].status, 'queued'); assert.equal(recovered.runs.length, 2);
  assert.equal(recovered.artifacts.length, 0); assert.equal(sends, 1);
});

test('MCP projection preserves source Markdown and keeps raw results in the execution receipt', async (t) => {
  const original = '# Real returned document\n\n| Original | Table |\n| --- | --- |\n| a | b |\n\n```js\nconst exact = true;\n```\n\n[Original reference](https://example.com/source)';
  let mediaOnly = false;
  const returned = () => mediaOnly ? { content: [{ type: 'image', mimeType: 'image/png', data: 'TEST_FIXTURE_NOT_REAL_IMAGE' }, { type: 'resource_link', name: 'Original resource', uri: 'https://example.com/resource' }] } : { content: [{ type: 'text', text: original }], structuredContent: { evidence: 'RAW_RECEIPT_ONLY' } };
  const r = await remote(t, (message, response) => {
    if (message.method === 'initialize') return rpcReply(response, message, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
    if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    if (message.method === 'tools/list') return rpcReply(response, message, { tools: [{ name: 'read_document', inputSchema: { type: 'object' } }] });
    return rpcReply(response, message, returned());
  });
  const f = await fixture(t);
  const connection = await f.api('/api/connections', { name: 'Original service', type: 'mcp', url: r.url });
  const execute = async () => {
    const created = await f.api('/api/threads', { text: 'Read the selected source', mode: 'connection', connectionId: connection.body.id, action: { toolName: 'read_document', arguments: {} }, clientId: clientId() });
    const pending = await f.wait(created.body.id, (thread) => thread.status === 'needs_input');
    assert.match(pending.decisions[0].summary, /将向 Original service 提交预览中的参数/);
    assert.doesNotMatch(pending.decisions[0].summary, /可能修改/);
    await f.api(`/api/decisions/${pending.decisions[0].id}`, { choice: 'approve', version: 1, clientId: clientId() });
    return f.wait(pending.id, (thread) => thread.status === 'completed');
  };
  const done = await execute(), artifact = (await f.api(`/api/artifacts/${done.artifacts[0].id}`)).body;
  assert.ok(artifact.body.startsWith(original)); assert.ok(artifact.body.includes(r.url));
  assert.match(artifact.body, /核验范围/); assert.doesNotMatch(artifact.body, /RAW_RECEIPT_ONLY|```json/);
  assert.equal(done.runs[0].remoteReceipt.result.content[0].text, original);
  assert.equal(done.runs[0].remoteReceipt.result.structuredContent.evidence, 'RAW_RECEIPT_ONLY');
  mediaOnly = true;
  const media = await execute(), mediaArtifact = (await f.api(`/api/artifacts/${media.artifacts[0].id}`)).body;
  assert.match(mediaArtifact.body, /服务返回图片内容/); assert.match(mediaArtifact.body, /https:\/\/example.com\/resource/);
  assert.doesNotMatch(mediaArtifact.body, /Real returned document|TEST_FIXTURE_NOT_REAL_IMAGE/);
  assert.equal(media.runs[0].remoteReceipt.result.content[0].data, 'TEST_FIXTURE_NOT_REAL_IMAGE');
});

test('accepted thread and message receipts remain idempotent after their selected memory is deleted', async (t) => {
  const f = await fixture(t);
  const memory = (await f.api('/api/memories', { text: 'Explicit synthetic memory for this accepted request', clientId: clientId() })).body;
  const createInput = { text: 'First local task', mode: 'local', memoryIds: [memory.id], clientId: clientId() };
  const created = await f.api('/api/threads', createInput);
  await f.wait(created.body.id, (thread) => thread.status === 'completed');
  const messageInput = { text: 'One accepted followup', mode: 'local', memoryIds: [memory.id], clientId: clientId() };
  const accepted = await f.api(`/api/threads/${created.body.id}/messages`, messageInput);
  const done = await f.wait(created.body.id, (thread) => thread.status === 'completed' && thread.runs.length === 2);
  assert.equal((await f.api(`/api/memories/${memory.id}`, null, 'DELETE')).status, 200);
  const restoredCreate = await f.api('/api/threads', createInput);
  const restoredMessage = await f.api(`/api/threads/${created.body.id}/messages`, messageInput);
  assert.equal(restoredCreate.status, 201); assert.equal(restoredCreate.body.id, created.body.id);
  assert.equal(restoredMessage.status, 200); assert.equal(restoredMessage.body.runs.at(-1).id, accepted.body.runs.at(-1).id);
  const current = (await f.api(`/api/threads/${done.id}`)).body;
  assert.equal(current.runs.length, 2); assert.equal(current.artifacts.length, 2);
  assert.equal((await f.api('/api/threads', { ...createInput, clientId: clientId() })).status, 404);
  assert.equal((await f.api('/api/threads', { ...createInput, text: 'Different content under old key' })).status, 409);
});

test('accepted remote thread and message receipts survive connection deletion without dispatching again', async (t) => {
  let sends = 0;
  const r = await remote(t, (message, response) => {
    if (message.method === 'message/send') {
      sends++; return rpcReply(response, message, { kind: 'task', id: `accepted-${sends}`, status: { state: 'working' } });
    }
    return rpcReply(response, message, { kind: 'task', id: message.params.id, status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'An actually returned synthetic remote result' }] }] });
  });
  const f = await fixture(t), connection = (await f.api('/api/connections', { name: 'Owned receipt fixture', type: 'a2a', url: r.url })).body;
  const createInput = { text: 'Accepted remote task', mode: 'connection', connectionId: connection.id, clientId: clientId() };
  const created = await f.api('/api/threads', createInput);
  const completeLatest = async (runCount) => {
    const pending = await f.wait(created.body.id, (thread) => thread.status === 'needs_input' && thread.runs.length === runCount);
    const decision = pending.decisions.at(-1);
    await f.api(`/api/decisions/${decision.id}`, { choice: 'approve', version: decision.version, clientId: clientId() });
    return f.wait(created.body.id, (thread) => thread.status === 'completed' && thread.runs.length === runCount);
  };
  await completeLatest(1);
  const messageInput = { text: 'Accepted second remote task', mode: 'connection', connectionId: connection.id, clientId: clientId() };
  const accepted = await f.api(`/api/threads/${created.body.id}/messages`, messageInput);
  const done = await completeLatest(2);
  assert.equal(sends, 2);
  assert.equal((await f.api(`/api/connections/${connection.id}`, null, 'DELETE')).status, 200);
  assert.equal((await f.api('/api/threads', createInput)).body.id, created.body.id);
  const replay = await f.api(`/api/threads/${created.body.id}/messages`, messageInput);
  assert.equal(replay.status, 200); assert.equal(replay.body.runs.at(-1).id, accepted.body.runs.at(-1).id);
  assert.equal((await f.api(`/api/threads/${done.id}`)).body.artifacts.length, 2); assert.equal(sends, 2);
  assert.equal((await f.api('/api/threads', { ...createInput, clientId: clientId() })).status, 404);
});

test('loopback origin checks, JSON limits, explicit memories, and corrupted artifacts fail safely', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/bootstrap', null, 'GET', { Origin: 'https://untrusted.example' })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: f.app.address().port, path: '/api/bootstrap', headers: { Host: 'evil.example' } }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    request.once('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await f.api('/api/threads', { text: 'missing memory', memoryIds: ['not-present'], clientId: clientId() })).status, 404);
  assert.equal((await f.api('/api/connections', { name: 'credential URL', type: 'a2a', url: 'https://user:secret@example.com/rpc' })).status, 400);
  assert.equal((await f.api('/api/connections', { name: 'external cleartext', type: 'a2a', url: 'http://example.com/rpc' })).status, 400);
  const created = await f.api('/api/threads', { text: 'local report', mode: 'local', clientId: clientId() });
  const done = await f.wait(created.body.id, (thread) => thread.status === 'completed');
  const artifact = f.app.store.require('artifact', done.artifacts[0].id); artifact.body = 'tampered'; f.app.store.put('artifact', artifact);
  assert.equal((await f.api(`/api/artifacts/${artifact.id}`)).status, 500);
});
