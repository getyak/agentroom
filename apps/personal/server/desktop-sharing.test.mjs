import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalServer } from './index.mjs';

const discover = async () => ({ agents: [{ id: 'pi', name: 'Pi', installed: true, auth: { status: 'configured' }, execution: { supported: true } }] });
async function fixture(t, discovery = discover) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-sharing-'));
  let calls = 0; const prompts = [];
  const host = await createPersonalServer({ dataDir: join(root, 'host'), port: 0, codexCommand: '/missing', discoverLocalAgents: discovery,
    sharingAddresses: () => ['127.0.0.1'], sharingPort: 0, nodePollMs: 0,
    executeLocalAgent: async ({ prompt }) => { calls++; prompts.push(prompt); return { markdown: '来自 Mac mini 的回复' }; } });
  const peer = await createPersonalServer({ dataDir: join(root, 'peer'), port: 0, codexCommand: '/missing', discoverLocalAgents: async () => ({ agents: [] }), nodePollMs: 0, remotePollMs: 5 });
  await host.listen(); await peer.listen();
  t.after(async () => { await peer.close(); await host.close(); await rm(root, { recursive: true, force: true }); });
  const api = async (app, path, body) => {
    const r = await fetch(`http://127.0.0.1:${app.address().port}/api${path}`, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  await api(host, '/contacts');
  const contact = (await api(host, '/contacts', { kind: 'agent', name: '研究伙伴', handle: 'researcher', instructions: '回答前核对资料', binding: { type: 'local', localAgentId: 'pi' }, clientId: 'create-research-contact' })).body;
  return { root, host, peer, api, contact, calls: () => calls, prompts };
}
async function enable(f) {
  const saved = await f.api(f.host, '/sharing', { enabled: true, host: '127.0.0.1', name: 'Mac mini', contactIds: [f.contact.id] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const invite = await f.api(f.host, '/sharing/invite', {});
  assert.equal(invite.status, 200);
  return invite.body;
}
async function until(probe) {
  const deadline = Date.now() + 5000;
  do { const value = await probe(); if (value) return value; await new Promise(resolve => setImmediate(resolve)); } while (Date.now() < deadline);
  throw new Error('Expected shared task did not complete');
}

test('remote cards follow the source configuration and retain dated observations when offline', async t => {
  let model = 'source-model';
  const f = await fixture(t, async () => ({ checkedAt: new Date().toISOString(), agents: [{ id: 'pi', name: 'Pi', installed: true, auth: { status: 'configured' }, execution: { supported: true },
    profile: { agentId: 'pi', defaults: { provider: 'synthetic', model, thinking: 'high' }, models: [{ provider: 'synthetic', id: model, reasoning: true, thinkingLevels: ['high'] }], providers: ['synthetic'], thinkingLevels: ['high'], version: model },
    quota: { status: 'available', checkedAt: '2026-11-14T08:00:00.000Z', windows: [{ remainingPercent: 42, windowMinutes: 300 }], accountId: 'PRIVATE' } }] }));
  const invite = await enable(f);
  const added = await f.api(f.peer, '/nodes/connect', invite);
  assert.equal(added.status, 201);
  const remote = async () => (await f.api(f.peer, '/contacts')).body.contacts.find(c => c.binding?.type === 'connection');
  const first = await remote();
  assert.equal(first.agentInfo.model, model); assert.equal(first.agentInfo.thinking, 'high');
  assert.equal(first.agentInfo.quota.windows[0].remainingPercent, 42);
  assert.ok(!JSON.stringify(first.agentInfo).includes('PRIVATE'));
  model = 'changed-source-model';
  await f.api(f.peer, `/nodes/${added.body.node.id}/check`, {});
  assert.equal((await remote()).agentInfo.model, model);
  const observed = (await remote()).agentInfo.checkedAt;
  await f.api(f.host, '/sharing', { enabled: false });
  assert.equal((await f.api(f.peer, `/nodes/${added.body.node.id}/check`, {})).status, 502);
  const last = await remote();
  assert.equal(last.agentInfo.checkedAt, observed); assert.equal(last.agentInfo.model, model);
  assert.equal(last.presence.state, 'reconnecting'); assert.equal(f.calls(), 0);
});

test('desktop sharing is opt-in, exports selected contacts and keeps tokens and private history out of ordinary responses', async t => {
  const f = await fixture(t);
  assert.equal((await f.api(f.host, '/sharing')).body.enabled, false);
  const invite = await enable(f);
  const forbidden = await fetch(`${invite.url}/.well-known/agentroom-node.json`);
  assert.equal(forbidden.status, 401);
  const manifest = await (await fetch(`${invite.url}/.well-known/agentroom-node.json`, { headers: { Authorization: `Bearer ${invite.token}` } })).json();
  assert.equal(manifest.kind, 'desktop'); assert.equal(manifest.agents.length, 1); assert.equal(manifest.agents[0].name, '研究伙伴');
  assert.ok(!JSON.stringify(manifest).includes('回答前核对资料'));
  assert.ok(!JSON.stringify((await f.api(f.host, '/sharing')).body).includes(invite.token));
  assert.ok(!(await readFile(join(f.root, 'host', 'personal.sqlite'))).includes(Buffer.from(invite.token)));
  const browser = await fetch(`${invite.url}/.well-known/agentroom-node.json`, { headers: { Authorization: `Bearer ${invite.token}`, Origin: 'https://untrusted.example' } });
  assert.equal(browser.status, 403);
});

test('private guest and legacy group identities cannot be published or called through a stale selection', async t => {
  const f = await fixture(t), invite = await enable(f);
  const hidden = [
    { ...f.contact, id: 'legacy_group_role', handle: 'legacy', groupLegacy: true },
    { ...f.contact, id: 'external_guest_role', handle: 'guest', externalGuest: true },
  ];
  for (const contact of hidden) f.host.store.put('contact', contact);
  const status = (await f.api(f.host, '/sharing')).body;
  assert.ok(hidden.every(contact => !status.contacts.some(item => item.id === contact.id)));
  const rejected = await f.api(f.host, '/sharing', { enabled: true, host: '127.0.0.1', name: 'Mac mini', contactIds: [hidden[0].id] });
  assert.equal(rejected.status, 400);
  const previous = f.host.sharing.config();
  f.host.store.put('setting', { ...previous, contactIds: [f.contact.id, ...hidden.map(contact => contact.id)] });
  const manifest = await (await fetch(`${invite.url}/.well-known/agentroom-node.json`, { headers: { Authorization: `Bearer ${invite.token}` } })).json();
  assert.deepEqual(manifest.agents.map(agent => agent.id), [f.contact.id]);
  for (const contact of hidden) {
    const response = await fetch(`${invite.url}/agents/${contact.id}`, { method: 'POST', headers: { Authorization: `Bearer ${invite.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'hidden-role', method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: `hidden-message-${contact.id}`, parts: [{ kind: 'text', text: 'must not execute' }] } } }) });
    assert.equal(response.status, 409);
    assert.ok(f.host.store.get('contact', contact.id), 'original group identity must be preserved');
  }
  assert.equal(f.calls(), 0);
});

test('a second AgentRoom imports the host contact and chats with its persona in an isolated execution', async t => {
  const f = await fixture(t), invite = await enable(f);
  f.host.store.put('memory', { id: 'private-memory', text: 'UNRELATED_PRIVATE_MEMORY' });
  const added = await f.api(f.peer, '/nodes/connect', { ...invite, clientId: 'connect-device-first' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const people = (await f.api(f.peer, '/contacts')).body.contacts, imported = people.find(c => c.binding?.type === 'connection');
  assert.ok(imported.name.includes('研究伙伴')); assert.equal(imported.presence.deviceName, 'Mac mini'); assert.equal(imported.presence.state, 'online');
  const chat = (await f.api(f.peer, '/chats', { kind: 'direct', memberIds: [imported.id], clientId: 'chat-device-first' })).body;
  await f.api(f.peer, `/threads/${chat.id}/messages`, { text: '介绍你的角色', clientId: 'message-device-first' });
  const done = await until(async () => { const thread = f.peer.store.require('thread', chat.id); return thread.runs[0]?.status === 'completed' && thread; });
  assert.ok(done.messages.some(m => m.text.includes('来自 Mac mini'))); assert.equal(f.calls(), 1);
  assert.ok(f.prompts[0].includes('回答前核对资料')); assert.ok(!f.prompts[0].includes('UNRELATED_PRIVATE_MEMORY'));
  const local = (await f.api(f.host, '/chats', { kind: 'direct', memberIds: [f.contact.id], clientId: 'local-chat-after-peer' })).body;
  assert.notEqual(local.purpose, 'device_request', 'ordinary direct chat must never reuse a hidden device request');
});

test('shared task ids are durable and duplicate-safe; stopping and starting preserve recovery authority', async t => {
  const f = await fixture(t), invite = await enable(f);
  const rpc = (method, params, token = invite.token, url = invite.url) => fetch(`${url}/agents/${f.contact.id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'rpc-first', method, params }) });
  const params = { message: { kind: 'message', role: 'user', messageId: 'shared-message-first', parts: [{ kind: 'text', text: 'hello' }] } };
  assert.equal((await rpc('message/send', params)).status, 200);
  assert.equal((await rpc('message/send', params)).status, 200);
  await until(() => f.calls() === 1);
  assert.equal((await rpc('message/send', { message: { ...params.message, parts: [{ kind: 'text', text: 'changed' }] } })).status, 409);
  await f.api(f.host, '/sharing', { enabled: false });
  assert.equal((await f.api(f.host, '/sharing')).body.enabled, false);
  const next = await enable(f);
  assert.equal(next.token, invite.token, 'ordinary stop/start must preserve access to accepted tasks');
  const result = await (await rpc('tasks/get', { id: params.message.messageId }, next.token, next.url)).json();
  assert.equal(result.result.id, params.message.messageId);
  const wrongContact = await fetch(`${next.url}/agents/agent_pi`, { method: 'POST', headers: { Authorization: `Bearer ${next.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'wrong-contact', method: 'tasks/get', params: { id: params.message.messageId } }) });
  assert.equal(wrongContact.status, 404);
});

test('closing during a pending bind releases the actual socket', async t => {
  const f = await fixture(t); await enable(f);
  await f.host.sharing.stopListener();
  const starting = f.host.sharing.listen(), listener = f.host.sharing.server;
  await f.host.sharing.close(); await starting;
  assert.equal(listener.listening, false);
  assert.equal(f.host.sharing.server, null);
});

test('a device with no shared contacts cannot claim a successful enrollment', async t => {
  const f = await fixture(t), invite = await enable(f);
  await f.api(f.host, '/sharing', { enabled: true, host: '127.0.0.1', name: 'Mac mini', contactIds: [] });
  const current = (await f.api(f.host, '/sharing/invite', {})).body;
  const result = await f.api(f.peer, '/nodes/connect', { ...current, clientId: 'connect-empty-device' });
  assert.equal(result.status, 409); assert.equal(result.body.error.code, 'node_empty');
  assert.equal(f.peer.store.list('connection').length, 0);
  assert.ok(invite.token);
});

test('a full directory of Chinese contact names and descriptions fits the bounded manifest', async t => {
  const f = await fixture(t), ids = [];
  for (let index = 0; index < 100; index++) {
    const contact = { ...f.contact, id: `contact_chinese_${index}`, handle: `chinese${index}`, name: '研'.repeat(80), description: '资料'.repeat(150) };
    f.host.store.put('contact', contact); ids.push(contact.id);
  }
  await f.api(f.host, '/sharing', { enabled: true, host: '127.0.0.1', name: 'Mac mini', contactIds: ids });
  const invitation = (await f.api(f.host, '/sharing/invite', {})).body;
  const added = await f.api(f.peer, '/nodes/connect', { ...invitation, clientId: 'connect-large-chinese-catalog' });
  assert.equal(added.status, 201, JSON.stringify(added.body)); assert.equal(added.body.connections.length, 100);
});

test('workspace switching freezes remote acceptance until the switch is cancelled', async t => {
  const f = await fixture(t), invite = await enable(f);
  assert.equal((await f.host.prepareWorkspaceSwitch()).blockingRuns, 0);
  const response = await fetch(`${invite.url}/.well-known/agentroom-node.json`, { headers: { Authorization: `Bearer ${invite.token}` } });
  assert.equal(response.status, 503);
  f.host.cancelWorkspaceSwitch();
  assert.equal((await fetch(`${invite.url}/.well-known/agentroom-node.json`, { headers: { Authorization: `Bearer ${invite.token}` } })).status, 200);
});

test('reopening the host preserves device identity, credential and accepted result without executing again', async t => {
  const f = await fixture(t), invite = await enable(f);
  const send = async (url, method, params) => {
    const response = await fetch(`${url}/agents/${f.contact.id}`, { method: 'POST', headers: { Authorization: `Bearer ${invite.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'restart-rpc', method, params }) });
    assert.equal(response.status, 200); return (await response.json()).result;
  };
  await send(invite.url, 'message/send', { message: { kind: 'message', role: 'user', messageId: 'persisted-peer-message', parts: [{ kind: 'text', text: '保存回复' }] } });
  await until(async () => (await send(invite.url, 'tasks/get', { id: 'persisted-peer-message' })).status.state === 'completed');
  const identity = f.host.sharing.identity.nodeId;
  await f.host.close();
  const reopened = await createPersonalServer({ dataDir: join(f.root, 'host'), port: 0, codexCommand: '/missing', discoverLocalAgents: discover,
    sharingAddresses: () => ['127.0.0.1'], sharingPort: 0, nodePollMs: 0, executeLocalAgent: async () => assert.fail('completed remote task must not execute again') });
  t.after(() => reopened.close()); await reopened.listen();
  await until(() => reopened.sharing.status().url);
  const next = reopened.sharing.invitation();
  assert.equal(next.token, invite.token); assert.equal(reopened.sharing.identity.nodeId, identity);
  const task = await send(next.url, 'tasks/get', { id: 'persisted-peer-message' });
  assert.equal(task.status.state, 'completed'); assert.ok(task.artifacts[0].parts[0].text.includes('来自 Mac mini'));
  assert.equal(f.calls(), 1);
});
