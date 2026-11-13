import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createPersonalServer } from './index.mjs';

// These are synthetic credentials used only by the local HTTP fixtures below.
const TOKEN_A = 'SYNTHETIC_TEST_BEARER_ACCOUNT_A_GET476_012345';
const TOKEN_B = 'SYNTHETIC_TEST_BEARER_ACCOUNT_B_GET476_987654';
let serial = 0;
const key = () => `auth-test-request-${++serial}`;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentstudio-auth-test-'));
  const changes = new EventEmitter();
  let app;
  const launch = async () => { app = await createPersonalServer({ dataDir: directory, port: 0, ...options, onChange: () => changes.emit('change') }); await app.listen(); };
  await launch();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, get app() { return app; },
    async restart() { await app.close(); await launch(); },
    async api(path, body, method = body ? 'POST' : 'GET') {
      const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
    },
    wait(threadId, predicate) {
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); changes.off('change', check); };
        const check = () => { const thread = app.store.get('thread', threadId); if (thread && predicate(thread)) { cleanup(); resolve(thread); } };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Authenticated fixture did not reach the expected state')); }, 5000);
        changes.on('change', check); check();
      });
    },
  };
}

async function remote(t, handler) {
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    let message; try { message = JSON.parse(body); } catch { response.writeHead(400); response.end(); return; }
    try { await handler(message, response, request); }
    catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/rpc` };
}

function reply(response, request, result) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}

async function pendingTask(f, connection, action) {
  const created = await f.api('/api/threads', { text: 'Process the explicitly selected synthetic account data', mode: 'connection', connectionId: connection.id, ...(action ? { action } : {}), clientId: key() });
  assert.equal(created.status, 201);
  return f.wait(created.body.id, (thread) => thread.status === 'needs_input');
}

async function approve(f, pending) {
  const decision = pending.decisions.at(-1);
  assert.equal((await f.api(`/api/decisions/${decision.id}`, { choice: 'approve', version: decision.version, clientId: key() })).status, 200);
}

function assertNoSecrets(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!serialized.includes(TOKEN_A), 'account A synthetic token must not be exposed');
  assert.ok(!serialized.includes(TOKEN_B), 'account B synthetic token must not be exposed');
}

test('Bearer A2A connections survive restart, keep same-endpoint accounts separate, and redact echoed credentials', async (t) => {
  const requests = [], ownership = new Map();
  const r = await remote(t, (message, response, request) => {
    const auth = request.headers.authorization;
    if (![ `Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}` ].includes(auth)) { response.writeHead(401); response.end(); return; }
    requests.push({ method: message.method, auth });
    if (message.method === 'message/send') {
      const taskId = `owned-${message.params.message.messageId}`; ownership.set(taskId, auth);
      return reply(response, message, { kind: 'task', id: taskId, status: { state: 'working' } });
    }
    assert.equal(ownership.get(message.params.id), auth);
    return reply(response, message, { kind: 'task', id: message.params.id, status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: `# Original account result\nEcho: ${auth}` }] }] });
  });
  const f = await fixture(t);
  const inputA = { name: 'Synthetic account A', type: 'a2a', url: r.url, token: TOKEN_A, clientId: key() };
  const a = (await f.api('/api/connections', inputA)).body;
  assert.deepEqual(a.auth, { type: 'bearer', configured: true, identityVerified: false });
  assert.equal((await f.api('/api/connections', inputA)).body.id, a.id);
  await f.restart();
  const oldApproval = await pendingTask(f, a);
  const b = (await f.api('/api/connections', { name: 'Synthetic account B', type: 'a2a', url: r.url, token: TOKEN_B, clientId: key() })).body;
  assert.notEqual(a.id, b.id); assert.equal(requests.length, 0);
  assert.deepEqual(oldApproval.decisions[0].identity, { label: 'Synthetic account A', authentication: 'bearer', identityVerified: false });
  await approve(f, oldApproval);
  const doneA = await f.wait(oldApproval.id, (thread) => thread.status === 'completed');
  assert.ok(requests.every((request) => request.auth === `Bearer ${TOKEN_A}`));
  const bTask = await pendingTask(f, b); await approve(f, bTask);
  const doneB = await f.wait(bTask.id, (thread) => thread.status === 'completed');
  assert.deepEqual(requests.map((request) => request.auth), [`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`, `Bearer ${TOKEN_B}`]);
  assert.match(doneA.messages.at(-1).text, /\[REDACTED\]/);
  for (const endpoint of ['/api/bootstrap', '/api/connections', `/api/threads/${doneA.id}`, `/api/threads/${doneB.id}`, `/api/artifacts/${doneA.artifacts[0].id}`, `/api/artifacts/${doneA.artifacts[0].id}/download`]) {
    assertNoSecrets((await f.api(endpoint)).body);
  }
  for (const connection of (await f.api('/api/connections')).body.connections) {
    assert.equal(connection.credentialRef, undefined); assert.equal(connection.credentialVersion, undefined); assert.equal(connection.credentialFingerprint, undefined);
  }
  for (const filename of ['personal.sqlite', 'personal.sqlite-wal']) assertNoSecrets((await readFile(join(f.directory, filename))).toString('latin1'));
  const credentialFiles = await readdir(join(f.directory, 'vault/credentials'));
  assert.equal(credentialFiles.length, 2);
  for (const filename of credentialFiles) {
    const path = join(f.directory, 'vault/credentials', filename), bytes = await readFile(path, 'utf8');
    assertNoSecrets(bytes); assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(JSON.parse(bytes).format, 1);
  }
  assert.equal((await stat(join(f.directory, 'vault/master.key'))).size, 32);
  assert.equal((await stat(join(f.directory, 'vault/master.key'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.directory, 'vault'))).mode & 0o777, 0o700);
});

test('MCP authenticates initialization, discovery, and tools/call; sanitized raw receipts and catalog never expose the token to the model', async (t) => {
  const methods = [];
  const r = await remote(t, (message, response, request) => {
    assert.equal(request.headers.authorization, `Bearer ${TOKEN_A}`); methods.push(message.method);
    if (message.method === 'initialize') {
      response.setHeader('Mcp-Session-Id', 'synthetic-session-A');
      return reply(response, message, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Synthetic MCP', version: '1' } });
    }
    assert.equal(request.headers['mcp-session-id'], 'synthetic-session-A');
    if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    if (message.method === 'tools/list') return reply(response, message, { tools: [{ name: 'read', description: `Untrusted echoed ${TOKEN_A}`, inputSchema: { type: 'object' } }] });
    return reply(response, message, { content: [{ type: 'text', text: `# Original MCP text\nCredential echo ${TOKEN_A}` }], structuredContent: { echoedAuthorization: `Bearer ${TOKEN_A}` } });
  });
  const scriptDirectory = await mkdtemp(join(tmpdir(), 'agentstudio-auth-planner-'));
  t.after(() => rm(scriptDirectory, { recursive: true, force: true }));
  const script = join(scriptDirectory, 'planner.mjs'), capture = join(scriptDirectory, 'prompt.txt');
  const plan = { kind: 'document', markdown: '# Actual synthetic document', why: 'Local document task' };
  await writeFile(script, `import{writeFileSync}from'node:fs';let s='';for await(const c of process.stdin)s+=c;writeFileSync(${JSON.stringify(capture)},s);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(plan))}}}));console.log(JSON.stringify({type:'turn.completed'}));`);
  const f = await fixture(t, { codexCommand: process.execPath, codexArgs: [script] });
  const added = await f.api('/api/connections', { name: 'Synthetic MCP', type: 'mcp', url: r.url, token: TOKEN_A, clientId: key() });
  assert.equal(added.status, 201); await f.restart();
  const tools = await f.api(`/api/connections/${added.body.id}/tools`); assertNoSecrets(tools.body); assert.match(tools.body.tools[0].description, /REDACTED/);
  const pending = await pendingTask(f, added.body, { toolName: 'read', arguments: {} }); await approve(f, pending);
  const done = await f.wait(pending.id, (thread) => thread.status === 'completed');
  assert.equal(done.runs[0].remoteReceipt.result.structuredContent.echoedAuthorization, 'Bearer [REDACTED]'); assertNoSecrets(done);
  assertNoSecrets((await f.api(`/api/artifacts/${done.artifacts[0].id}`)).body);
  const local = await f.api('/api/threads', { text: 'Write a local document', clientId: key() });
  await f.wait(local.body.id, (thread) => thread.status === 'completed');
  const prompt = await readFile(capture, 'utf8'); assertNoSecrets(prompt);
  assert.doesNotMatch(prompt, /credentialRef|credentialFingerprint|synthetic-session-A/);
  assert.ok(methods.includes('initialize') && methods.includes('notifications/initialized') && methods.includes('tools/list') && methods.includes('tools/call'));
});

test('credential version changes cannot turn an old approval into a new account authorization', async (t) => {
  let dispatched = 0;
  const r = await remote(t, (message, response) => { dispatched++; reply(response, message, {}); });
  const f = await fixture(t);
  const added = await f.api('/api/connections', { name: 'Bound account', type: 'a2a', url: r.url, token: TOKEN_A });
  const pending = await pendingTask(f, added.body);
  const privateConnection = f.app.store.require('connection', added.body.id);
  privateConnection.credentialVersion += 1; f.app.store.put('connection', privateConnection);
  const decision = pending.decisions[0];
  const rejected = await f.api(`/api/decisions/${decision.id}`, { choice: 'approve', version: decision.version, clientId: key() });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'approval_identity_changed');
  assert.equal(f.app.store.require('thread', pending.id).decisions[0].state, 'pending');
  assert.equal(dispatched, 0); assertNoSecrets(rejected.body);
});

test('failed connection creation removes only the new credential, preserves existing accounts, and validates token input', async (t) => {
  const r = await remote(t, (_message, response) => { response.writeHead(401); response.end(); });
  const f = await fixture(t);
  const existing = await f.api('/api/connections', { name: 'Existing A', type: 'a2a', url: r.url, token: TOKEN_A, clientId: key() });
  const before = await readdir(join(f.directory, 'vault/credentials'));
  const failed = await f.api('/api/connections', { name: 'Rejected B', type: 'mcp', url: r.url, token: TOKEN_B, clientId: key() });
  assert.equal(failed.status, 502); assertNoSecrets(failed.body);
  assert.deepEqual(await readdir(join(f.directory, 'vault/credentials')), before);
  assert.deepEqual((await f.api('/api/connections')).body.connections.map((connection) => connection.id), [existing.body.id]);
  for (const token of ['short', 'synthetic\r\nheader', 'with whitespace token', 'x'.repeat(8001)]) {
    assert.equal((await f.api('/api/connections', { name: 'Invalid', type: 'a2a', url: r.url, token })).status, 400);
  }
  assert.equal((await f.api('/api/connections', { name: 'Invalid header', type: 'a2a', url: r.url, headers: { Authorization: 'anything' } })).status, 400);
  const sameKey = key(), first = { name: 'Idempotent A', type: 'a2a', url: r.url, token: TOKEN_A, clientId: sameKey };
  assert.equal((await f.api('/api/connections', first)).status, 201);
  assert.equal((await f.api('/api/connections', { ...first, token: TOKEN_B })).status, 409);
  assert.deepEqual(await readdir(join(f.directory, 'vault/credentials')), before);
});

test('deletion protects pending and unknown account tasks, and safe deletion removes the encrypted credential', async (t) => {
  const r = await remote(t, (_message, response) => { response.destroy(); });
  const f = await fixture(t);
  const added = await f.api('/api/connections', { name: 'Protected account', type: 'a2a', url: r.url, token: TOKEN_A });
  const pending = await pendingTask(f, added.body);
  const ref = f.app.store.require('connection', added.body.id).credentialRef;
  assert.equal((await f.api(`/api/connections/${added.body.id}`, null, 'DELETE')).status, 409);
  assert.equal((await stat(join(f.directory, 'vault/credentials', `${ref}.json`))).isFile(), true);
  await approve(f, pending);
  await f.wait(pending.id, (thread) => thread.status === 'unknown');
  assert.equal((await f.api(`/api/connections/${added.body.id}`, null, 'DELETE')).status, 409);
  assert.equal((await stat(join(f.directory, 'vault/credentials', `${ref}.json`))).isFile(), true);
  const unused = await f.api('/api/connections', { name: 'Unused account B', type: 'a2a', url: r.url, token: TOKEN_B });
  const unusedRef = f.app.store.require('connection', unused.body.id).credentialRef;
  assert.equal((await f.api(`/api/connections/${unused.body.id}`, null, 'DELETE')).status, 200);
  await assert.rejects(stat(join(f.directory, 'vault/credentials', `${unusedRef}.json`)), { code: 'ENOENT' });
  assert.equal((await stat(join(f.directory, 'vault/credentials', `${ref}.json`))).isFile(), true);
});

test('a missing or damaged master key blocks authentication without regenerating or overwriting it', async (t) => {
  let requests = 0;
  const r = await remote(t, (_message, response) => { requests++; response.writeHead(401); response.end(); });
  const f = await fixture(t);
  const added = await f.api('/api/connections', { name: 'Synthetic key recovery account', type: 'a2a', url: r.url, token: TOKEN_A });
  const master = join(f.directory, 'vault/master.key'), originalKey = await readFile(master);
  const files = await readdir(join(f.directory, 'vault/credentials'));
  const encrypted = await readFile(join(f.directory, 'vault/credentials', files[0]));
  await writeFile(master, Buffer.alloc(31, 0x61)); await f.restart();
  const pending = await pendingTask(f, added.body); await approve(f, pending);
  const blocked = await f.wait(pending.id, (thread) => thread.status === 'blocked');
  assert.match(blocked.summary, /凭据库或密钥无法读取/); assert.equal(requests, 0); assert.equal((await readFile(master)).length, 31);
  assert.deepEqual(await readFile(join(f.directory, 'vault/credentials', files[0])), encrypted);
  await rm(master); await f.restart();
  assert.equal((await f.api('/api/connections', { name: 'Do not replace missing key', type: 'a2a', url: r.url, token: TOKEN_B })).status, 503);
  await assert.rejects(stat(master), { code: 'ENOENT' });
  await writeFile(master, originalKey, { mode: 0o600 }); await f.restart();
  assert.deepEqual(f.app.store.vault.authorization(f.app.store.require('connection', added.body.id)), { Authorization: `Bearer ${TOKEN_A}` });
});

test('authenticated redirects are never followed to another endpoint', async (t) => {
  let destinationRequests = 0, sourceRequests = 0;
  const destination = await remote(t, (_message, response) => { destinationRequests++; response.writeHead(500); response.end(); });
  const source = await remote(t, (_message, response, request) => {
    sourceRequests++; assert.equal(request.headers.authorization, `Bearer ${TOKEN_A}`);
    response.writeHead(307, { Location: destination.url }); response.end();
  });
  const f = await fixture(t);
  const added = await f.api('/api/connections', { name: 'No redirect account', type: 'a2a', url: source.url, token: TOKEN_A });
  const pending = await pendingTask(f, added.body); await approve(f, pending);
  const unknown = await f.wait(pending.id, (thread) => thread.status === 'unknown');
  assert.equal(sourceRequests, 1); assert.equal(destinationRequests, 0); assert.equal(unknown.artifacts.length, 0); assertNoSecrets(unknown);
});

test('concurrent idempotent MCP creation keeps one connection and one encrypted credential', async (t) => {
  let initialized = 0, bothStarted;
  const arrivals = new Promise((resolve) => { bothStarted = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = await remote(t, async (message, response, request) => {
    assert.equal(request.headers.authorization, `Bearer ${TOKEN_A}`);
    if (message.method === 'initialize') {
      initialized++; if (initialized === 2) bothStarted(); await gate;
      response.setHeader('Mcp-Session-Id', `synthetic-${message.id}`);
      return reply(response, message, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Concurrent synthetic MCP', version: '1' } });
    }
    response.writeHead(202); response.end();
  });
  const f = await fixture(t);
  const input = { name: 'Concurrent owned account', type: 'mcp', url: r.url, token: TOKEN_A, clientId: key() };
  const requests = [f.api('/api/connections', input), f.api('/api/connections', input)];
  await arrivals; release();
  const [first, second] = await Promise.all(requests);
  assert.equal(first.status, 201); assert.equal(second.status, 201); assert.equal(first.body.id, second.body.id);
  assert.equal((await f.api('/api/connections')).body.connections.length, 1);
  assert.equal((await readdir(join(f.directory, 'vault/credentials'))).length, 1);
});

test('a failed new vault write leaves the existing master key and credential unchanged', async (t) => {
  const r = await remote(t, (_message, response) => { response.writeHead(500); response.end(); });
  const f = await fixture(t);
  const added = await f.api('/api/connections', { name: 'Immutable original account', type: 'a2a', url: r.url, token: TOKEN_A });
  const connection = f.app.store.require('connection', added.body.id), vault = f.app.store.vault;
  const recordPath = join(vault.recordsDirectory, `${connection.credentialRef}.json`);
  const beforeRecord = await readFile(recordPath), beforeKey = await readFile(vault.keyPath);
  const originalDirectory = vault.recordsDirectory, invalidDirectory = join(f.directory, 'synthetic-write-failure');
  await writeFile(invalidDirectory, 'not a directory', { mode: 0o600 });
  try {
    vault.recordsDirectory = invalidDirectory;
    assert.throws(() => vault.create(TOKEN_B, { id: 'con_synthetic_new_failure', type: 'a2a', url: r.url, credentialVersion: 1 }));
  } finally { vault.recordsDirectory = originalDirectory; }
  assert.deepEqual(await readFile(recordPath), beforeRecord); assert.deepEqual(await readFile(vault.keyPath), beforeKey);
  assert.deepEqual(vault.authorization(connection), { Authorization: `Bearer ${TOKEN_A}` });
});
