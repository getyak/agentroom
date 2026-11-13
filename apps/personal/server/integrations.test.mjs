import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalServer } from './index.mjs';

const agents = ['codex', 'claude'].map(id => ({ id, name: id, installed: true, version: '1.2.3', auth: { status: 'configured' }, execution: { supported: true },
  profile: { agentId: id, defaults: { provider: 'synthetic', model: 'synthetic-model', thinking: 'high' }, models: [], providers: ['synthetic'], thinkingLevels: ['high'], version: 'synthetic-profile' } }));
test('CC Switch metadata refreshes independently and synthetic discovery excludes the real home', async t => {
  const isolated = await fixture(t);
  assert.deepEqual((await isolated.request('/integrations')).body.ccSwitch, { status: 'not_found', clients: [], profiles: null });
  let calls = 0;
  const injected = await fixture(t, { discoverCcSwitch: async () => ({ status: ++calls === 1 ? 'available' : 'unavailable', clients: [], profiles: calls === 1 ? 2 : null }) });
  const first = await injected.request('/integrations');
  assert.equal(first.status, 200); assert.equal(first.body.ccSwitch.profiles, 2);
  const refreshed = await injected.request('/integrations/refresh', {});
  assert.equal(refreshed.status, 200); assert.equal(refreshed.body.ccSwitch.status, 'unavailable');
  assert.equal(refreshed.body.agents.length, 2);
});

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentstudio-integrations-'));
  const app = await createPersonalServer({ dataDir, port: 0, codexCommand: '/missing-get479-synthetic-cli',
    discoverLocalAgents: async () => ({ checkedAt: new Date().toISOString(), agents }), ...options });
  const address = await app.listen(); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (path, body) => {
    const response = await fetch(base + '/api' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, request };
}
async function until(probe) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { const result = await probe(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Acceptance condition timed out');
}
async function provider(t, handler) {
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const sendJSON = (response, body, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };

test('selecting a discovered local agent persists, and accepted work keeps the original executor', async t => {
  let finish; const called = [];
  const { app, request } = await fixture(t, { executeLocalAgent: async input => {
    called.push(input.id); await new Promise(resolve => { finish = resolve; });
    return { markdown: '# Synthetic Claude result', identity: { id: input.id, name: 'Claude Code' } };
  } });
  assert.equal((await request('/integrations/local/claude', {})).status, 200);
  const accepted = (await request('/threads', { text: '合成执行者快照', clientId: 'snapshot-executor-1' })).body;
  await until(() => finish);
  await request('/integrations/local/codex', {});
  finish();
  const done = await until(async () => { const thread = (await request('/threads/' + accepted.id)).body; return thread.status === 'completed' && thread; });
  assert.deepEqual(called, ['claude']); assert.equal(done.runs[0].localAgentId, 'claude');
  assert.equal(done.runs[0].chosenExecutor, 'claude'); assert.equal(app.store.get('artifact', done.artifacts[0].id).source, 'claude');
  assert.equal((await request('/bootstrap')).body.settings.localAgentId, 'codex');
});

test('missing login blocks activation and does not replace the selected provider', async t => {
  const { request } = await fixture(t, { discoverLocalAgents: async () => ({ agents: [{ ...agents[1], auth: { status: 'required' } }] }) });
  assert.equal((await request('/integrations/local/claude', {})).status, 409);
  assert.equal((await request('/bootstrap')).body.settings.localAgentId, 'codex');
  assert.equal((await request('/integrations/local/not-a-command', { command: 'anything' })).status, 404);
});

test('public A2A URL connects without a token; raw request receipt survives changed metadata and provider outage', async t => {
  let name = 'My synthetic agent', reads = 0;
  const endpoint = await provider(t, (request, response) => {
    reads++; sendJSON(response, { name, url: `http://${request.headers.host}/rpc`, protocolVersion: '0.3.0', preferredTransport: 'JSONRPC' });
  });
  const { request, app } = await fixture(t);
  const body = { url: endpoint, clientId: 'auto-url-original-request' };
  const first = await request('/integrations/connect', body);
  assert.equal(first.status, 201); assert.equal(first.body.type, 'a2a'); assert.equal(first.body.name, name);
  const firstReads = reads; name = 'A changed remote display name';
  const again = await request('/integrations/connect', body);
  assert.equal(again.status, 201); assert.deepEqual(again.body, first.body); assert.equal(reads, firstReads);
  assert.equal(app.store.list('connection').length, 1);
  assert.equal((await request('/integrations/connect', { ...body, url: endpoint + '/other' })).status, 409);
});

test('concurrent identical quick connects share discovery and never execute an MCP tool', async t => {
  let initializes = 0, tools = 0, calls = 0;
  const endpoint = await provider(t, async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.method === 'initialize') { initializes++; sendJSON(response, { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'Synthetic' }, capabilities: { tools: {} } } }); }
    else if (rpc.method === 'notifications/initialized') response.writeHead(202).end();
    else if (rpc.method === 'tools/list') { tools++; sendJSON(response, { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'read', inputSchema: { type: 'object' } }] } }); }
    else { calls++; response.writeHead(400).end(); }
  });
  const { request, app } = await fixture(t, { toolPresets: [{ id: 'deepwiki', name: 'Synthetic docs', type: 'mcp', url: endpoint + '/mcp' }] });
  const body = { presetId: 'deepwiki', clientId: 'preset-same-click-double' };
  const results = await Promise.all([request('/integrations/connect', body), request('/integrations/connect', body)]);
  assert.ok(results.every(result => result.status === 201)); assert.equal(results[0].body.id, results[1].body.id);
  assert.deepEqual([initializes, tools, calls], [1, 1, 0]); assert.equal(app.store.list('connection').length, 1);
  assert.equal((await request('/integrations/connect', { presetId: 'deepwiki', url: 'https://example.com/' })).status, 400);
});

test('an agent card cannot transfer a credential to a different origin or accept credential URLs', async t => {
  let hostileReads = 0;
  const hostile = await provider(t, (_request, response) => { hostileReads++; response.writeHead(500).end(); });
  const endpoint = await provider(t, (_request, response) => sendJSON(response, { name: 'Untrusted metadata', url: hostile + '/rpc' }));
  const { request, app } = await fixture(t);
  assert.equal((await request('/integrations/connect', { url: endpoint, token: 'synthetic-private-credential' })).status, 400);
  assert.equal(hostileReads, 0); assert.equal(app.store.list('connection').length, 0);
  assert.equal((await request('/integrations/connect', { url: 'https://name:secret@example.com/' })).status, 400);
  assert.equal((await request('/integrations/connect', { url: 'http://192.0.2.8/rpc' })).status, 400);
});

test('unconfirmed local stop stays unknown after cancel and cannot replay or overlap queued work', async t => {
  let rejectExecution, executionCalls = 0;
  const { app, request } = await fixture(t, { executeLocalAgent: async () => {
    executionCalls++; return new Promise((_resolve, reject) => { rejectExecution = reject; });
  } });
  await request('/integrations/local/claude', {});
  const first = (await request('/threads', { text: '合成停止状态', clientId: 'stop-fence-first-request' })).body;
  await until(() => rejectExecution);
  await request(`/threads/${first.id}/messages`, { text: '排队后续', clientId: 'stop-fence-queued-followup' });
  await request(`/threads/${first.id}/cancel`, { clientId: 'stop-fence-cancel-request' });
  const failure = new Error('synthetic stop unconfirmed'); failure.code = 'stop_unconfirmed'; rejectExecution(failure);
  const unknown = await until(async () => { const value = (await request('/threads/' + first.id)).body; return value.status === 'unknown' && value; });
  assert.equal(unknown.runs[0].stopUnconfirmed, true); assert.equal(unknown.runs[1].status, 'queued');
  assert.equal((await request(`/threads/${first.id}/retry`, { clientId: 'stop-fence-no-retry-again' })).status, 409);
  await request(`/threads/${first.id}/cancel`, { clientId: 'stop-fence-no-clear-unknown' });
  assert.equal((await request('/threads/' + first.id)).body.status, 'unknown');
  assert.equal((await request('/threads', { text: 'another task', clientId: 'stop-fence-new-task' })).status, 409);
  assert.equal(executionCalls, 1);
  app.store.recover(); assert.equal(app.store.require('thread', first.id).runs[0].stopUnconfirmed, true);
});
