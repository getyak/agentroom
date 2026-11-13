import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalServer } from './index.mjs';
import { initializeMCP } from './runtime.mjs';
import { PersonalStore } from './store.mjs';

const agentInventory = ['codex', 'claude', 'pi'].map(id => ({ id, name: id, installed: true, auth: { status: 'configured' }, execution: { supported: true } }));
const tool = { name: 'read_trip', description: 'Read synthetic trip', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } };
let serial = 0;
const key = () => `mcp-integration-${++serial}`;

async function fixture(t, agentId, { repeatCursor = false, afterRequest, failCall = false } = {}) {
  let writes = 0, receipt, requestCount = 0;
  const changes = new EventEmitter(), dataDir = await mkdtemp(join(tmpdir(), 'agentroom-mcp-flow-'));
  const remote = http.createServer(async (request, response) => {
    let data = ''; for await (const chunk of request) data += chunk;
    const rpc = JSON.parse(data);
    if (rpc.method === 'notifications/initialized') return response.writeHead(202).end();
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
    else if (rpc.method === 'tools/list') result = rpc.params.cursor ? { tools: [tool], ...(repeatCursor ? { nextCursor: 'page-2' } : {}) } : { tools: [], nextCursor: 'page-2' };
    else if (rpc.method === 'tools/call') { writes++; if (failCall) return response.destroy(); result = { content: [{ type: 'text', text: 'SYNTHETIC_TRIP_OK' }] }; }
    else return response.writeHead(400).end();
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  let app;
  const options = { dataDir, port: 0, codexCommand: '/synthetic/no-real-cli', discoverLocalAgents: async () => ({ agents: agentInventory }),
    onChange: () => changes.emit('change'), executeLocalAgent: async input => {
      requestCount++;
      assert.equal(input.id, agentId); assert.ok(input.toolSession);
      const call = async (name, args, callId) => {
        const response = await fetch(input.toolSession.endpoint, { method: 'POST', headers: { authorization: `Bearer ${input.toolSession.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args, callId }) });
        const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.result;
      };
      const found = await call('mcp_search', { query: 'trip' }, 'find-trip');
      assert.equal(found.tools.length, 1); // tool lives on the second discovery page
      receipt = await call('mcp_request', { connectionId: found.tools[0].connectionId, catalogFingerprint: found.tools[0].catalogFingerprint, toolName: tool.name, arguments: { id: 'synthetic-trip' } }, 'read-trip');
      await afterRequest?.(app, receipt);
      return { markdown: '{"action":"reply","text":"已经申请，等待你批准。"}', identity: { id: agentId } };
    } };
  const start = async () => { app = await createPersonalServer(options); await app.listen(); };
  await start();
  t.after(async () => { await app.close(); await new Promise(resolve => remote.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const wait = (threadId, predicate) => new Promise((resolve, reject) => {
    const check = () => { const thread = app.store.get('thread', threadId); if (thread && predicate(thread)) { clearTimeout(timer); changes.off('change', check); resolve(thread); } };
    const timer = setTimeout(() => { changes.off('change', check); reject(new Error(`Timed out: ${JSON.stringify(app.store.get('thread', threadId)?.runs)}`)); }, 5000);
    changes.on('change', check); check();
  });
  const connection = (await api('/connections', { name: 'Trip', type: 'mcp', url: `http://127.0.0.1:${remote.address().port}/mcp` })).body;
  await api('/contacts');
  const contact = (await api('/contacts', { kind: 'agent', name: '旅行规划师', handle: 'trip_planner', binding: { type: 'local', localAgentId: agentId }, clientId: key() })).body;
  const friend = (await api('/contacts', { kind: 'human', name: '旅伴', handle: 'travel_friend', clientId: key() })).body;
  const chat = (await api('/chats', { kind: 'group', title: '合成旅行群', memberIds: [contact.id, friend.id], clientId: key() })).body;
  assert.ok(contact.id, JSON.stringify(contact)); assert.ok(chat.id, JSON.stringify(chat));
  const saved = await api(`/mcp/access/${connection.id}`, { version: 0, enabled: true, contactIds: [contact.id], threadIds: [chat.id], toolNames: [tool.name], clientId: key() });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  return { api, wait, connection, contact, chat, writes: () => writes, receipt: () => receipt, requestCount: () => requestCount,
    get app() { return app; }, restart: async () => { await app.close(); await start(); } };
}

for (const agentId of ['codex', 'claude', 'pi']) test(`${agentId}: group broker discovers paginated tools, requests approval, and dispatches once with sender identity`, async t => {
  const f = await fixture(t, agentId);
  await f.api(`/threads/${f.chat.id}/messages`, { text: '读取旅程', clientId: key() });
  const pending = await f.wait(f.chat.id, thread => thread.decisions.some(item => item.state === 'pending'));
  assert.equal(f.writes(), 0); assert.equal(f.receipt().executed, false);
  const decision = pending.decisions[0];
  assert.equal((await f.api('/approvals')).body.approvals.find(item => item.id === decision.id).contact.name, '旅行规划师');
  const approve = { clientId: key(), version: decision.version, choice: 'approve' };
  assert.equal((await f.api(`/decisions/${decision.id}`, approve)).status, 200);
  const completed = await f.wait(f.chat.id, thread => thread.runs.some(run => run.id === f.receipt().runId && run.status === 'completed'));
  const message = completed.messages.find(message => message.runId === f.receipt().runId);
  assert.equal(message.contactId, f.contact.id); assert.match(message.text, /SYNTHETIC_TRIP_OK/);
  assert.equal(f.writes(), 1); assert.equal(f.requestCount(), 1);
  await f.api(`/decisions/${decision.id}`, approve); assert.equal(f.writes(), 1);
  await f.restart(); assert.equal(f.writes(), 1);
});

test('revoking the enabled scope before approval rejects dispatch, and settings survive restart', async t => {
  const f = await fixture(t, 'claude');
  await f.api(`/threads/${f.chat.id}/messages`, { text: '读取旅程', clientId: key() });
  const pending = await f.wait(f.chat.id, thread => thread.decisions.some(item => item.state === 'pending'));
  await f.api(`/mcp/access/${f.connection.id}`, { version: 1, enabled: false, contactIds: [f.contact.id], threadIds: [f.chat.id], toolNames: [tool.name], clientId: key() });
  const result = await f.api(`/decisions/${pending.decisions[0].id}`, { version: pending.decisions[0].version, choice: 'approve', clientId: key() });
  assert.equal(result.status, 409); assert.equal(f.writes(), 0);
  await f.restart();
  const policy = (await f.api('/mcp/access')).body.connections.find(item => item.id === f.connection.id).access;
  assert.equal(policy.enabled, false); assert.equal(policy.version, 2); assert.equal(f.writes(), 0);
});

test('rejected agent tool requests cannot be cloned into an unbound generic retry', async t => {
  const f = await fixture(t, 'claude');
  await f.api(`/threads/${f.chat.id}/messages`, { text: '读取旅程', clientId: key() });
  const pending = await f.wait(f.chat.id, thread => thread.decisions.some(item => item.state === 'pending'));
  const decision = pending.decisions[0];
  await f.api(`/decisions/${decision.id}`, { version: decision.version, choice: 'reject', clientId: key() });
  const before = f.app.store.require('thread', f.chat.id).runs.length;
  const retry = await f.api(`/threads/${f.chat.id}/retry`, { runId: f.receipt().runId, clientId: key() });
  assert.equal(retry.status, 409); assert.equal(retry.body.error.code, 'mcp_request_retry_requires_discovery');
  assert.equal(f.app.store.require('thread', f.chat.id).runs.length, before); assert.equal(f.writes(), 0);
});

test('a lost mutation response stays unknown across restart without a second tools/call', async t => {
  const f = await fixture(t, 'claude', { failCall: true });
  await f.api(`/threads/${f.chat.id}/messages`, { text: '读取旅程', clientId: key() });
  const pending = await f.wait(f.chat.id, thread => thread.decisions.some(item => item.state === 'pending'));
  await f.api(`/decisions/${pending.decisions[0].id}`, { version: pending.decisions[0].version, choice: 'approve', clientId: key() });
  await f.wait(f.chat.id, thread => thread.runs.some(run => run.id === f.receipt().runId && run.status === 'unknown'));
  assert.equal(f.writes(), 1); await f.restart(); assert.equal(f.writes(), 1);
  assert.equal(f.app.store.get('decision_attempt', f.receipt().runId).state, 'unknown');
});

test('repeated discovery cursor is rejected rather than using an incomplete catalog', async t => {
  const f = await fixture(t, 'claude', { repeatCursor: true });
  const result = await f.api(`/connections/${f.connection.id}/tools`);
  assert.equal(result.status, 502); assert.equal(result.body.error.code, 'invalid_tool_catalog');
  assert.equal(f.writes(), 0);
});

test('an older MCP handshake cannot overwrite a renewed identity or resurrect a deleted connection', async t => {
  for (const removed of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'agentroom-mcp-cas-')), store = new PersonalStore(dir);
    let release, entered; const started = new Promise(resolve => { entered = resolve; });
    const remote = http.createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const rpc = JSON.parse(raw);
      if (rpc.method === 'notifications/initialized') { entered(); await new Promise(resolve => { release = resolve; }); return response.writeHead(202).end(); }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } }));
    });
    await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
    t.after(async () => { store.close(); await new Promise(resolve => remote.close(resolve)); await rm(dir, { recursive: true, force: true }); });
    const connection = { id: 'cas', name: 'Synthetic MCP', type: 'mcp', url: `http://127.0.0.1:${remote.address().port}/mcp`, credentialVersion: 0 };
    store.put('connection', connection);
    const handshake = initializeMCP(store, connection); await started;
    if (removed) store.delete('connection', connection.id);
    else store.put('connection', { ...connection, credentialVersion: 2, url: connection.url + '-new' });
    release();
    await assert.rejects(handshake, error => error.code === 'approval_identity_changed');
    assert.equal(store.get('connection', connection.id)?.credentialVersion, removed ? undefined : 2);
  }
});
