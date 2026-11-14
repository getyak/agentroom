import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalServer } from './index.mjs';

let sequence = 0;
const key = () => `chat-tools-integration-${++sequence}`;
const inventory = ['codex', 'claude', 'pi'].map(id => ({ id, name: id, installed: true, auth: { status: 'configured' }, execution: { supported: true } }));
async function fixture(t, { agent = 'codex', execute, remoteHandler } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agentroom-chat-integration-')), changes = new EventEmitter();
  let remote, app;
  if (remoteHandler) {
    remote = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const rpc = JSON.parse(raw), result = await remoteHandler(rpc, res);
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  }
  const start = async () => {
    app = await createPersonalServer({ dataDir: dir, port: 0, codexCommand: process.execPath, discoverLocalAgents: async () => ({ agents: inventory }),
      executeLocalAgent: execute, onChange: () => changes.emit('change'), remotePollMs: 1 });
    await app.listen();
  };
  await start();
  t.after(async () => { await app.close(); if (remote) { remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); } await rm(dir, { recursive: true, force: true }); });
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const wait = (threadId, predicate) => new Promise((resolve, reject) => {
    const check = () => { const thread = app.store.get('thread', threadId); if (thread && predicate(thread)) { clearTimeout(timer); changes.off('change', check); resolve(thread); } };
    const timer = setTimeout(() => { changes.off('change', check); reject(new Error(`Expected chat transition: ${JSON.stringify(app.store.get('thread', threadId)?.runs)}`)); }, 5000);
    changes.on('change', check); check();
  });
  await api('/contacts');
  let binding = { type: 'local', localAgentId: agent };
  if (remote) {
    const connection = { id: 'remote_chat', type: 'a2a', name: 'Synthetic remote', url: `http://127.0.0.1:${remote.address().port}/a2a`,
      node: { id: 'synthetic_node', agentId: 'codex', taskIdScheme: 'messageId' } };
    app.store.put('connection', connection); binding = { type: 'connection', connectionId: connection.id };
  }
  const actor = (await api('/contacts', { kind: 'agent', name: '旅行规划师', handle: 'trip_planner', binding, clientId: key() })).body;
  const peer = (await api('/contacts', { kind: 'agent', name: '研究员', handle: 'researcher', binding: { type: 'local', localAgentId: 'codex' }, clientId: key() })).body;
  const chat = (await api('/chats', { kind: 'direct', memberIds: [actor.id], clientId: key() })).body;
  assert.ok(chat.id, JSON.stringify(chat));
  return { api, actor, peer, chat, wait, get app() { return app; }, restart: async () => { await app.close(); await start(); } };
}

for (const agent of ['codex', 'claude', 'pi']) test(`${agent}: native catalog can create a group through an owner decision and survives restart`, async t => {
  let receipt, peer;
  const f = await fixture(t, { agent, execute: async request => {
    assert.ok(request.toolSession.toolNames.includes('create_room'));
    const call = async (name, args, callId) => {
      const response = await fetch(request.toolSession.endpoint, { method: 'POST', headers: { authorization: `Bearer ${request.toolSession.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args, callId }) });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.result;
    };
    const contacts = await call('list_contacts', {}, 'directory'); assert.ok(contacts.contacts.find(c => c.id === peer));
    receipt = await call('create_room', { name: '合成旅行群', memberIds: [peer], text: '我们来讨论路线' }, 'group-once');
    return { markdown: '已提交建群确认卡，等待你批准。', identity: { agent } };
  } }); peer = f.peer.id;
  await f.api(`/threads/${f.chat.id}/messages`, { text: '帮我建旅行群', clientId: key() });
  const completed = await f.wait(f.chat.id, thread => thread.runs.at(-1)?.status === 'completed');
  assert.equal(receipt.status, 'pending_approval'); assert.equal(completed.decisions[0].kind, 'chat_action');
  assert.equal(f.app.store.list('thread').filter(t => t.title === '合成旅行群').length, 0);
  await f.restart();
  const command = { clientId: key(), version: 1, choice: 'approve' };
  assert.equal((await f.api(`/decisions/${receipt.decisionId}`, command)).status, 200);
  assert.equal((await f.api(`/decisions/${receipt.decisionId}`, command)).status, 200);
  const groups = f.app.store.list('thread').filter(t => t.title === '合成旅行群');
  assert.equal(groups.length, 1); assert.equal(groups[0].messages[0].contactId, f.actor.id);
});

test('A2A uses bounded JSON tool rounds without bearer callbacks and keeps chat approvals separate from dispatch', async t => {
  const sends = [], tasks = new Map(); let peer;
  const f = await fixture(t, { remoteHandler: async rpc => {
    if (rpc.method === 'tasks/get') return tasks.get(rpc.params.id);
    const message = rpc.params.message, content = JSON.parse(message.parts[0].text); sends.push({ id: message.messageId, content });
    assert.ok(content.agentroomTools.tools.some(t => t.name === 'create_room'));
    assert.doesNotMatch(JSON.stringify(content.agentroomTools), /Bearer|127\.0\.0\.1/);
    const round = content.toolResults.length;
    const output = round === 0 ? { action: 'tool_call', name: 'list_contacts', arguments: {}, callId: 'directory' }
      : round === 1 ? { action: 'tool_call', name: 'create_room', arguments: { name: '远端旅行群', memberIds: [peer] }, callId: 'create' }
        : { action: 'reply', text: '建群申请已经提交，请查看确认卡。' };
    const task = { kind: 'task', id: message.messageId, status: { state: 'completed', message: { parts: [{ kind: 'text', text: JSON.stringify(output) }] } } }; tasks.set(task.id, task); return task;
  } }); peer = f.peer.id;
  await f.api(`/threads/${f.chat.id}/messages`, { text: '帮我创建旅行群', clientId: key() });
  const completed = await f.wait(f.chat.id, thread => ['completed', 'failed', 'unknown'].includes(thread.runs.at(-1)?.status));
  assert.equal(completed.runs.at(-1).status, 'completed', JSON.stringify(completed.runs));
  assert.equal(sends.length, 3); assert.equal(new Set(sends.map(s => s.id)).size, 3);
  assert.match(sends[1].id, /_tools_1$/); assert.equal(completed.runs.at(-1).remoteRounds.length, 2);
  assert.equal(completed.decisions.length, 1); assert.equal(completed.decisions[0].kind, 'chat_action');
  assert.equal((await f.api(`/decisions/${completed.decisions[0].id}`, { clientId: key(), choice: 'approve', version: 1 })).status, 200);
  assert.equal(f.app.store.list('thread').filter(t => t.title === '远端旅行群').length, 1);
});

test('a lost second-round A2A receipt is reconciled by its own ID, without replaying either send', async t => {
  const sends = [], tasks = new Map();
  const f = await fixture(t, { remoteHandler: async (rpc, response) => {
    if (rpc.method === 'tasks/get') return tasks.get(rpc.params.id);
    const message = rpc.params.message; sends.push(message.messageId);
    const output = sends.length === 1 ? { action: 'tool_call', name: 'list_contacts', arguments: {}, callId: 'directory' } : { action: 'reply', text: '已查询联系人。' };
    const task = { kind: 'task', id: message.messageId, status: { state: 'completed', message: { parts: [{ kind: 'text', text: JSON.stringify(output) }] } } }; tasks.set(task.id, task);
    if (sends.length === 2) response.destroy(); return task;
  } });
  await f.api(`/threads/${f.chat.id}/messages`, { text: '看看联系人', clientId: key() });
  const uncertain = await f.wait(f.chat.id, thread => thread.runs.at(-1)?.status === 'unknown');
  const run = uncertain.runs.at(-1); assert.equal(run.externalTaskId, sends[1]); assert.equal(run.remoteRounds[0].messageId, sends[0]);
  await f.restart();
  const result = await f.api(`/threads/${f.chat.id}/reconcile`, { runId: run.id, clientId: key() });
  assert.equal(result.status, 200, JSON.stringify(result));
  const completed = await f.wait(f.chat.id, thread => thread.runs.at(-1)?.status === 'completed');
  assert.equal(sends.length, 2); assert.equal(completed.runs.at(-1).externalTaskId, sends[1]);
});
