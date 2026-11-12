import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createPersonalServer } from './index.mjs';

let sequence = 0;
const key = () => `messenger-test-${++sequence}`;
const detected = { checkedAt: new Date().toISOString(), agents: [
  { id: 'codex', name: 'Codex', installed: true, auth: { status: 'configured' }, execution: { supported: true } },
  { id: 'pi', name: 'Pi', installed: true, auth: { status: 'unknown' }, execution: { supported: false, reason: '尚未支持执行' } },
] };
const fake = `let p='';for await(const c of process.stdin)p+=c;let x=JSON.parse(p.split('<untrusted_thread_context>\\n')[1].split('\\n</untrusted_thread_context>')[0]);if(p.includes('planning ONE explicit MCP'))x={toolName:'echo',arguments:{text:JSON.stringify(x)}};console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(p.includes('Group participation:')?{action:'reply',text:JSON.stringify(x)}:x)}}));console.log(JSON.stringify({type:'turn.completed'}));`;
async function fixture(t, inventory = detected) {
  const dir = await mkdtemp(join(tmpdir(), 'agentstudio-messenger-'));
  const changes = new EventEmitter(); let app;
  const start = async () => {
    app = await createPersonalServer({ dataDir: dir, port: 0, codexCommand: process.execPath,
      codexArgs: ['--input-type=module', '-e', fake], discoverLocalAgents: async () => inventory,
      onChange: () => changes.emit('change') });
    await app.listen();
  };
  await start();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const api = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${app.address().port}/api${path}`, { method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const wait = (id, predicate) => new Promise((resolve, reject) => {
    const check = () => { const thread = app.store.get('thread', id); if (predicate(thread)) { clearTimeout(timer); changes.off('change', check); resolve(thread); } };
    const timer = setTimeout(() => { changes.off('change', check); reject(new Error(`Timed out ${JSON.stringify(app.store.get('thread', id)?.runs)}`)); }, 5000);
    changes.on('change', check); check();
  });
  await api('/contacts');
  return { api, wait, get store() { return app.store; }, async restart() { await app.close(); await start(); } };
}

// These regression cases exercise the retained explicit-addressing policy.
// Default autonomous participation has its own behavior tests.
async function legacyGroup(f, body) {
  const chat = (await f.api('/chats', body)).body;
  const responsePolicies = Object.fromEntries(chat.memberIds.filter(id => id !== 'self').map(id => [id, 'mention']));
  return (await f.api(`/chats/${chat.id}`, { version: chat.version, responsePolicies, clientId: key() })).body;
}

test('discovery, custom identities, stable direct chats and local-only people survive restart', async t => {
  const f = await fixture(t);
  const contacts = (await f.api('/contacts')).body.contacts;
  assert.ok(contacts.some(c => c.id === 'agent_codex' && c.availability === 'ready'));
  assert.ok(contacts.some(c => c.id === 'agent_pi' && c.availability === 'unsupported'));
  const body = { clientId: key(), kind: 'agent', name: '研究员', handle: 'researcher', instructions: '先核对来源', binding: { type: 'local', localAgentId: 'codex' } };
  const created = await f.api('/contacts', body);
  assert.equal(created.status, 201);
  assert.deepEqual((await f.api('/contacts', body)).body, created.body);
  assert.equal((await f.api('/contacts', { ...body, name: 'changed' })).status, 409);
  assert.equal((await f.api('/contacts', { ...body, clientId: key() })).status, 409);
  const contact = created.body;
  const chat = (await f.api('/chats', { kind: 'direct', memberIds: [contact.id], clientId: key() })).body;
  const again = (await f.api('/chats', { kind: 'direct', memberIds: [contact.id], clientId: key() })).body;
  assert.equal(chat.id, again.id); assert.equal(chat.runs.length, 0);
  const person = (await f.api('/contacts', { kind: 'human', name: '朋友', handle: 'friend', clientId: key() })).body;
  assert.equal(person.availability, 'local_only');
  const humanChat = (await f.api('/chats', { kind: 'direct', memberIds: [person.id], clientId: key() })).body;
  const humanMessage = await f.api(`/threads/${humanChat.id}/messages`, { text: '本地备忘', clientId: key() });
  assert.equal(humanMessage.body.runs.length, 0);
  assert.equal(humanMessage.body.messages[0].deliveryState, 'local_only');
  await f.restart();
  assert.equal((await f.api(`/contacts/${contact.id}`)).body.instructions, '先核对来源');
  assert.equal((await f.api(`/threads/${chat.id}`)).body.id, chat.id);
});

test('quick add adopts stable contacts once, preserving edits and adoption across restart', async t => {
  const f = await fixture(t);
  const originalThreads = f.store.list('thread').map(thread => thread.id);
  const candidate = (await f.api('/contacts/agent_codex')).body;
  assert.equal(candidate.added, false);
  const body = { agentIds: ['codex'], clientId: key() };
  const added = await f.api('/contacts/local', body);
  assert.equal(added.status, 200);
  assert.equal(added.body.contacts[0].id, candidate.id);
  assert.equal(added.body.contacts[0].added, true);
  assert.deepEqual((await f.api('/contacts/local', body)).body, added.body);
  const edited = (await f.api('/contacts/agent_codex', { name: '我的助手', version: candidate.version, clientId: key() })).body;
  const repeated = (await f.api('/contacts/local', { agentIds: ['codex', 'codex'], clientId: key() })).body.contacts;
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].name, '我的助手');
  assert.equal(repeated[0].version, edited.version);
  await f.restart();
  assert.equal((await f.api('/contacts/agent_codex')).body.added, true);
  assert.deepEqual(f.store.list('thread').map(thread => thread.id), originalThreads);
});

test('quick add validates the whole batch and cannot accept missing or unsupported agents', async t => {
  const f = await fixture(t);
  for (const agentIds of [[], ['codex', 'pi'], ['codex', 'missing'], 'codex']) {
    const rejected = await f.api('/contacts/local', { agentIds, clientId: key() });
    assert.ok(rejected.status >= 400);
    assert.equal((await f.api('/contacts/agent_codex')).body.added, false);
  }
  assert.equal((await f.api('/contacts/local', { agentIds: ['codex'], command: 'anything', clientId: key() })).status, 400);
});

test('legacy contacts remain added and opening a candidate direct chat explicitly adopts it', async t => {
  const f = await fixture(t);
  const previous = f.store.require('contact', 'agent_codex');
  delete previous.added;
  f.store.put('contact', { ...previous, name: '旧联系人' });
  assert.equal((await f.api('/contacts')).body.contacts.find(c => c.id === previous.id).added, true);
  const pi = f.store.require('contact', 'agent_pi');
  assert.equal(pi.added, false);
  const chat = await f.api('/chats', { kind: 'direct', memberIds: [pi.id], clientId: key() });
  assert.equal(chat.status, 201);
  assert.equal((await f.api('/contacts/agent_pi')).body.added, true);
  assert.equal((await f.api('/contacts/agent_codex')).body.name, '旧联系人');
});

test('quick add accepts signed-out assistants and preserves honest status after a fresh missing-install check', async t => {
  const inventory = structuredClone(detected);
  inventory.agents[0].auth.status = 'required';
  const f = await fixture(t, inventory);
  const added = await f.api('/contacts/local', { agentIds: ['codex'], clientId: key() });
  assert.equal(added.status, 200);
  assert.equal(added.body.contacts[0].availability, 'login_required');
  inventory.agents[0].installed = false;
  const missing = await f.api('/contacts/local', { agentIds: ['codex'], clientId: key() });
  assert.equal(missing.status, 409);
  assert.equal((await f.api('/contacts/agent_codex')).body.added, true);
  assert.equal((await f.api('/contacts/agent_codex')).body.availability, 'not_installed');
});

test('concurrent quick adds with one request key produce one relationship and reject changed input', async t => {
  const f = await fixture(t);
  const body = { agentIds: ['codex'], clientId: key() };
  const [one, two] = await Promise.all([f.api('/contacts/local', body), f.api('/contacts/local', body)]);
  assert.equal(one.status, 200); assert.deepEqual(one, two);
  assert.equal((await f.api('/contacts/local', { ...body, agentIds: ['pi'] })).status, 409);
  assert.equal(f.store.list('contact').filter(c => c.id === 'agent_codex' && c.added).length, 1);
});

test('group mentions target exact members, each user message is stored once and accepted identities stay fixed', async t => {
  const f = await fixture(t);
  const a = (await f.api('/contacts', { kind: 'agent', name: 'Ada', handle: 'ada', instructions: 'Original identity', binding: { type: 'local', localAgentId: 'codex' }, clientId: key() })).body;
  const b = (await f.api('/contacts', { kind: 'agent', name: 'Bo', handle: 'bo', binding: { type: 'local', localAgentId: 'codex' }, clientId: key() })).body;
  const chat = await legacyGroup(f, { kind: 'group', title: '讨论', memberIds: [a.id, b.id], clientId: key() });
  const quiet = (await f.api(`/threads/${chat.id}/messages`, { text: 'Ambient message', clientId: key() })).body;
  assert.equal(quiet.runs.length, 0);
  assert.equal((await f.api(`/threads/${chat.id}/messages`, { text: '@adams 不应唤起 Ada', clientId: key() })).body.runs.length, 0);
  const input = { text: '@ada，@bo 一起看看', clientId: key() };
  const sent = await f.api(`/threads/${chat.id}/messages`, input);
  assert.equal(sent.body.runs.length, 2);
  assert.equal(sent.body.messages.filter(m => m.text === input.text).length, 1);
  assert.equal((await f.api(`/threads/${chat.id}/messages`, input)).body.runs.length, 2);
  await f.api(`/contacts/${a.id}`, { ...a, name: 'Updated', instructions: 'New identity', version: a.version, clientId: key() });
  const done = await f.wait(chat.id, x => x.runs.every(r => r.status === 'completed'));
  assert.equal(done.runs[0].contactSnapshot.name, 'Ada');
  assert.equal(done.runs[0].contactSnapshot.instructions, 'Original identity');
  assert.deepEqual(done.messages.filter(m => m.role === 'assistant').map(m => m.contactId).sort(), [a.id, b.id].sort());
  const returned = done.messages.find(m => m.role === 'assistant' && m.contactId === a.id);
  assert.equal(JSON.parse(returned.text).agentIdentity.name, 'Ada');
  assert.equal((await f.api(`/threads/${chat.id}/messages`, { text: '@pi outsider', clientId: key() })).body.runs.length, 2);
});

test('new members cannot see earlier messages, identity and membership updates use versions', async t => {
  const f = await fixture(t);
  const chat = await legacyGroup(f, { kind: 'group', title: 'Privacy', memberIds: ['agent_codex'], clientId: key() });
  await f.api(`/threads/${chat.id}/messages`, { text: 'BEFORE_JOIN_PRIVATE', clientId: key() });
  const b = (await f.api('/contacts', { kind: 'agent', name: 'Later', handle: 'later', binding: { type: 'local', localAgentId: 'codex' }, clientId: key() })).body;
  const updated = await f.api(`/chats/${chat.id}`, { version: chat.version, memberIds: [...chat.memberIds, b.id], clientId: key() });
  assert.equal(updated.status, 200);
  f.store.updateThread(chat.id, item => item.messages.push({ id: 'synthetic-late-reply', role: 'assistant', contactId: 'agent_codex',
    text: 'LATE_REPLY_FROM_BEFORE_JOIN', recipientIds: ['self', 'agent_codex'], createdAt: new Date().toISOString(), attachments: [] }));
  assert.equal((await f.api(`/chats/${chat.id}`, { version: chat.version, title: 'stale', clientId: key() })).status, 409);
  await f.api(`/threads/${chat.id}/messages`, { text: '@later 现在加入', clientId: key() });
  const done = await f.wait(chat.id, x => x.runs.at(-1)?.status === 'completed');
  const response = done.messages.find(m => m.role === 'assistant' && m.contactId === b.id);
  assert.ok(!response.text.includes('BEFORE_JOIN_PRIVATE'));
  assert.ok(!response.text.includes('LATE_REPLY_FROM_BEFORE_JOIN'));
  assert.equal((await f.api('/chats', { kind: 'direct', memberIds: ['agent_codex', b.id], clientId: key() })).status, 400);
});

test('addressed remote group chat sends immediately with scoped identity and a natural reply', async t => {
  const f = await fixture(t); const submissions = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const c of req) text += c;
    const rpc = JSON.parse(text); submissions.push(rpc);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'message', role: 'agent', messageId: 'synthetic', parts: [{ kind: 'text', text: 'Synthetic chat reply' }] } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const connection = (await f.api('/connections', { name: 'Synthetic', type: 'a2a', url: `http://127.0.0.1:${server.address().port}/rpc` })).body;
  const a = (await f.api('/contacts', { kind: 'agent', name: 'Remote A', handle: 'remote-a', binding: { type: 'connection', connectionId: connection.id }, clientId: key() })).body;
  const chat = await legacyGroup(f, { kind: 'group', title: 'Approvals', memberIds: [a.id, 'agent_codex'], clientId: key() });
  await f.api(`/threads/${chat.id}/messages`, { text: '@remote-a Please help', clientId: key() });
  const done = await f.wait(chat.id, x => ['completed', 'needs_input'].includes(x.runs[0]?.status));
  assert.equal(done.runs[0].status, 'completed', 'addressing a contact already authorizes ordinary chat');
  assert.equal(done.decisions.length, 0);
  const payload = JSON.parse(submissions[0].params.message.parts[0].text);
  assert.equal(payload.context.agentIdentity.name, a.name);
  assert.equal(payload.context.conversation.kind, 'group');
  assert.equal(done.messages.at(-1).text, 'Synthetic chat reply');
  assert.equal(done.messages.at(-1).contactId, a.id);
  assert.equal(done.runs[0].remoteVerification.externalEffectsVerified, false);
  await f.api(`/threads/${chat.id}/messages`, { text: '@codex Local independent reply', clientId: key() });
  const independent = await f.wait(chat.id, x => x.runs.at(-1)?.status === 'completed');
  assert.equal(independent.decisions.length, 0);
  const approvals = (await f.api('/approvals')).body.approvals;
  assert.equal(approvals.length, 0);
  assert.equal(submissions.length, 1);
});

test('remote direct chat followups send once per accepted message without approval', async t => {
  const f = await fixture(t); const submissions = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const rpc = JSON.parse(text); submissions.push(rpc);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'message', role: 'agent', messageId: `reply-${submissions.length}`, parts: [{ kind: 'text', text: `Synthetic reply ${submissions.length}` }] } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const connection = (await f.api('/connections', { name: 'Synthetic Muse', type: 'a2a', url: `http://127.0.0.1:${server.address().port}/rpc` })).body;
  const contact = (await f.api('/contacts')).body.contacts.find(c => c.binding?.connectionId === connection.id);
  const chat = (await f.api('/chats', { kind: 'direct', memberIds: [contact.id], clientId: key() })).body;
  const body = { text: 'Hello', clientId: key(), mode: 'local', action: { toolName: 'untrusted', arguments: {} } };
  await f.api(`/threads/${chat.id}/messages`, body);
  const first = await f.wait(chat.id, x => ['completed', 'needs_input'].includes(x.runs[0]?.status));
  assert.equal(first.runs[0].status, 'completed');
  await f.api(`/threads/${chat.id}/messages`, body);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].params.message.messageId, first.runs[0].id);
  await f.api(`/threads/${chat.id}/messages`, { text: 'Follow up', clientId: key() });
  const done = await f.wait(chat.id, x => ['completed', 'needs_input'].includes(x.runs[1]?.status));
  assert.equal(done.runs[1].status, 'completed'); assert.equal(done.decisions.length, 0);
  assert.deepEqual(done.messages.filter(m => m.role === 'assistant').map(m => m.text), ['Synthetic reply 1', 'Synthetic reply 2']);
  const context = JSON.parse(submissions[1].params.message.parts[0].text).context;
  assert.deepEqual(context.messages.map(m => m.text), ['Hello', 'Synthetic reply 1', 'Follow up']);
  assert.equal(submissions.length, 2);
});

test('queued contact chat and retry keep the accepted endpoint and credential binding private', async t => {
  for (const field of ['url', 'credentialRef', 'credentialVersion']) await t.test(field, async t => {
    const f = await fixture(t); let sends = 0, release;
    const gate = new Promise(resolve => { release = resolve; }); t.after(release);
    const server = http.createServer(async (req, res) => {
      let text = ''; for await (const chunk of req) text += chunk;
      const rpc = JSON.parse(text); sends++;
      await gate;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'message', role: 'agent', messageId: 'synthetic', parts: [{ kind: 'text', text: 'Synthetic reply' }] } }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
    const connection = (await f.api('/connections', { name: 'Bound contact', type: 'a2a', url: `http://127.0.0.1:${server.address().port}/rpc`, token: 'synthetic-chat-bearer' })).body;
    const contact = (await f.api('/contacts')).body.contacts.find(c => c.binding?.connectionId === connection.id);
    const chat = (await f.api('/chats', { kind: 'direct', memberIds: [contact.id], clientId: key() })).body;
    await f.api(`/threads/${chat.id}/messages`, { text: 'First', clientId: key() });
    await f.wait(chat.id, x => x.runs[0]?.deliveryState === 'sending');
    const queued = await f.api(`/threads/${chat.id}/messages`, { text: 'Queued', clientId: key() });
    assert.equal(queued.status, 200);
    assert.ok(!JSON.stringify(queued.body).includes('credentialRef'));
    assert.ok(!JSON.stringify(queued.body).includes('synthetic-chat-bearer'));
    const stored = f.store.require('connection', connection.id);
    f.store.put('connection', { ...stored, [field]: field === 'url' ? `${stored.url}/replacement` : field === 'credentialVersion' ? 2 : 'replacement-credential' });
    release();
    const blocked = await f.wait(chat.id, x => ['blocked', 'needs_input'].includes(x.runs[1]?.status));
    assert.equal(blocked.runs[1].status, 'blocked');
    assert.match(blocked.runs[1].error, /身份绑定已改变/);
    assert.equal(sends, 1);
    await f.restart();
    const retried = await f.api(`/threads/${chat.id}/retry`, { runId: blocked.runs[1].id, clientId: key() });
    assert.equal(retried.status, 200);
    const again = await f.wait(chat.id, x => x.runs[2]?.status === 'blocked');
    assert.match(again.runs[2].error, /身份绑定已改变/);
    assert.equal(again.decisions.length, 0); assert.equal(sends, 1);
  });
});

test('unknown contact sends cannot be repeated after restart, cancel or retry', async t => {
  const f = await fixture(t); let sends = 0;
  const server = http.createServer(async (req, res) => { for await (const _chunk of req) { /* consume synthetic request */ } sends++; res.destroy(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const connection = (await f.api('/connections', { name: 'Uncertain', type: 'a2a', url: `http://127.0.0.1:${server.address().port}/rpc` })).body;
  const contact = (await f.api('/contacts')).body.contacts.find(c => c.binding?.connectionId === connection.id);
  const chat = (await f.api('/chats', { kind: 'direct', memberIds: [contact.id], clientId: key() })).body;
  await f.api(`/threads/${chat.id}/messages`, { text: 'Send once', clientId: key() });
  const unknown = await f.wait(chat.id, x => ['unknown', 'needs_input'].includes(x.runs[0]?.status));
  assert.equal(unknown.runs[0].status, 'unknown'); assert.equal(unknown.decisions.length, 0);
  await f.restart();
  assert.equal((await f.api(`/threads/${chat.id}/retry`, { clientId: key() })).status, 409);
  assert.equal((await f.api(`/threads/${chat.id}/reconcile`, { clientId: key() })).status, 409);
  await f.api(`/threads/${chat.id}/cancel`, { clientId: key() });
  assert.equal((await f.api(`/threads/${chat.id}/messages`, { text: 'Do not repeat', clientId: key() })).status, 409);
  assert.equal(sends, 1);
});

test('contact task reconciliation after restart reads the original task without a message approval', async t => {
  const f = await fixture(t); const methods = []; let completed = false;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const rpc = JSON.parse(text); methods.push(rpc.method);
    if (rpc.method === 'tasks/get') assert.equal(rpc.params.id, 'synthetic-task');
    const result = { kind: 'task', id: 'synthetic-task', status: { state: completed ? 'completed' : 'input-required' },
      ...(completed ? { artifacts: [{ parts: [{ kind: 'text', text: 'Recovered synthetic reply' }] }] } : {}) };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const connection = (await f.api('/connections', { name: 'Recoverable', type: 'a2a', url: `http://127.0.0.1:${server.address().port}/rpc` })).body;
  const contact = (await f.api('/contacts')).body.contacts.find(c => c.binding?.connectionId === connection.id);
  const chat = (await f.api('/chats', { kind: 'direct', memberIds: [contact.id], clientId: key() })).body;
  await f.api(`/threads/${chat.id}/messages`, { text: 'Original request', clientId: key() });
  const blocked = await f.wait(chat.id, x => ['blocked', 'needs_input'].includes(x.runs[0]?.status));
  assert.equal(blocked.runs[0].status, 'blocked'); assert.equal(blocked.runs[0].externalTaskId, 'synthetic-task');
  await f.restart(); completed = true;
  assert.equal((await f.api(`/threads/${chat.id}/reconcile`, { clientId: key() })).status, 200);
  const done = await f.wait(chat.id, x => x.runs[0]?.status === 'completed');
  assert.equal(done.messages.at(-1).text, 'Recovered synthetic reply'); assert.equal(done.decisions.length, 0);
  assert.deepEqual(methods, ['message/send', 'tasks/get', 'tasks/get']);
});

test('newly joined remote contacts only receive post-join group material', async t => {
  const f = await fixture(t); let payload;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const rpc = JSON.parse(text); payload = JSON.parse(rpc.params.message.parts[0].text);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'message', role: 'agent', messageId: 'synthetic', parts: [{ kind: 'text', text: 'Synthetic joined reply' }] } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const chat = await legacyGroup(f, { kind: 'group', title: 'Private group', memberIds: ['agent_codex'], clientId: key() });
  await f.api(`/threads/${chat.id}/messages`, { text: 'PRIVATE_BEFORE_JOIN', attachments: [{ name: 'private.txt', text: 'PRIVATE_ATTACHMENT' }], clientId: key() });
  const connection = (await f.api('/connections', { name: 'Joined', type: 'a2a', url: `http://127.0.0.1:${server.address().port}/rpc` })).body;
  const contact = (await f.api('/contacts')).body.contacts.find(c => c.binding?.connectionId === connection.id);
  await f.api(`/chats/${chat.id}`, { version: chat.version, memberIds: ['agent_codex', contact.id], clientId: key() });
  await f.api(`/threads/${chat.id}/messages`, { text: `@${contact.handle} Hello`, clientId: key() });
  const done = await f.wait(chat.id, x => x.runs.some(run => run.contactId === contact.id && run.status === 'completed'));
  assert.equal(done.runs[0].status, 'completed');
  assert.ok(!JSON.stringify(payload).includes('PRIVATE_BEFORE_JOIN')); assert.ok(!JSON.stringify(payload).includes('PRIVATE_ATTACHMENT'));
  assert.equal(payload.context.messages.length, 1); assert.deepEqual(payload.sources, []);
});

test('broadcast skips unavailable members, but explicit unavailable targets reject without consuming the message', async t => {
  const f = await fixture(t);
  const chat = await legacyGroup(f, { kind: 'group', title: 'Broadcast', memberIds: ['agent_codex', 'agent_pi'], clientId: key() });
  const sent = (await f.api(`/threads/${chat.id}/messages`, { text: '@all 一起看看', clientId: key() })).body;
  assert.equal(sent.messages.length, 1); assert.equal(sent.runs.length, 1);
  assert.equal(sent.runs[0].contactId, 'agent_codex');
  assert.equal(sent.messages[0].skippedContacts[0].id, 'agent_pi');
  assert.equal((await f.api(`/threads/${chat.id}/messages`, { text: '@pi 你来', clientId: key() })).status, 409);
  assert.equal((await f.api(`/threads/${chat.id}`)).body.messages.filter(m => m.role === 'user').length, 1);
});

test('retry preserves the accepted identity and scope after contact changes', async t => {
  const f = await fixture(t);
  const original = (await f.api('/contacts/agent_codex')).body;
  const chat = (await f.api('/chats', { kind: 'direct', memberIds: [original.id], clientId: key() })).body;
  await f.api(`/threads/${chat.id}/messages`, { text: 'Original request', clientId: key() });
  const done = await f.wait(chat.id, x => x.runs[0]?.status === 'completed');
  f.store.updateThread(chat.id, x => { x.runs[0].status = 'blocked'; x.runs[0].error = 'Synthetic pre-dispatch retry'; });
  await f.api(`/contacts/${original.id}`, { name: 'Renamed', instructions: 'New instructions', version: original.version, clientId: key() });
  await f.api(`/threads/${chat.id}/retry`, { runId: done.runs[0].id, clientId: key() });
  const retried = await f.wait(chat.id, x => x.runs[1]?.status === 'completed');
  assert.deepEqual(retried.runs[1].contactSnapshot, done.runs[0].contactSnapshot);
  assert.equal(retried.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(JSON.parse(retried.messages.at(-1).text).agentIdentity.name, original.name);
});

test('reply wakes the author, paused agents stay quiet, and @all does not replay an uncertain lane', async t => {
  const f = await fixture(t);
  const other = (await f.api('/contacts', { kind: 'agent', name: 'Other', handle: 'other', binding: { type: 'local', localAgentId: 'codex' }, clientId: key() })).body;
  const chat = await legacyGroup(f, { kind: 'group', title: 'Reply', memberIds: [other.id, 'agent_codex'], clientId: key() });
  await f.api(`/threads/${chat.id}/messages`, { text: '@other first', clientId: key() });
  const first = await f.wait(chat.id, x => x.runs[0]?.status === 'completed');
  const replyId = first.messages.at(-1).id;
  await f.api(`/threads/${chat.id}/messages`, { text: 'Continue', replyTo: replyId, clientId: key() });
  const continued = await f.wait(chat.id, x => x.runs[1]?.status === 'completed');
  assert.equal(continued.runs[1].contactId, other.id);
  f.store.updateThread(chat.id, x => { x.runs[1].status = 'unknown'; x.runs[1].requiresReconciliation = true; });
  await f.api(`/threads/${chat.id}/messages`, { text: '@all new independent request', clientId: key() });
  const independent = await f.wait(chat.id, x => x.runs.at(-1)?.contactId === 'agent_codex' && x.runs.at(-1).status === 'completed');
  assert.equal(independent.runs.filter(r => r.contactId === other.id).length, 2);
  await f.api(`/chats/${chat.id}`, { version: chat.version, responsePolicies: { [other.id]: 'manual' }, clientId: key() });
  const paused = (await f.api(`/threads/${chat.id}/messages`, { text: '@other stay paused', replyTo: replyId, clientId: key() })).body;
  assert.equal(paused.runs.length, independent.runs.length);
});

test('a newly joined MCP agent reaches approval with only its post-join context', async t => {
  const f = await fixture(t);
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const c of req) text += c;
    const rpc = JSON.parse(text);
    if (rpc.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    const result = rpc.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Synthetic MCP', version: '1' } }
      : { tools: [{ name: 'echo', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } }] };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const chat = await legacyGroup(f, { kind: 'group', title: 'MCP privacy', memberIds: ['agent_codex'], clientId: key() });
  await f.api(`/threads/${chat.id}/messages`, { text: 'PRIVATE_BEFORE_MCP', clientId: key() });
  const connection = (await f.api('/connections', { name: 'MCP', type: 'mcp', url: `http://127.0.0.1:${server.address().port}/rpc` })).body;
  const member = (await f.api('/contacts', { kind: 'agent', name: 'MCP member', handle: 'mcp-member', binding: { type: 'connection', connectionId: connection.id }, clientId: key() })).body;
  await f.api(`/chats/${chat.id}`, { version: chat.version, memberIds: ['agent_codex', member.id], clientId: key() });
  const unconfigured = await f.api(`/threads/${chat.id}/messages`, { text: '@mcp-member hello', clientId: key() });
  assert.equal(unconfigured.status, 409); assert.ok(unconfigured.body.error.message.includes('明确选择聊天助手'));
  const configured = await f.api(`/contacts/${member.id}`, { version: member.version, chatBackend: { type: 'local', localAgentId: 'codex' }, clientId: key() });
  assert.equal(configured.status, 200); assert.equal(configured.body.availability, 'ready');
  await f.api(`/threads/${chat.id}/messages`, { text: '@mcp-member hello', clientId: key() });
  const pending = await f.wait(chat.id, x => x.decisions.length === 1 || x.runs.at(-1)?.status === 'blocked');
  assert.equal(pending.runs.at(-1).status, 'needs_input', pending.runs.at(-1).error);
  assert.ok(!pending.decisions[0].preview.includes('PRIVATE_BEFORE_MCP'));
  assert.ok(pending.decisions[0].preview.includes('MCP member'));
});

test('unread counts only incoming messages and read acknowledgments are bounded, monotonic and durable', async t => {
  const f = await fixture(t);
  const chat = (await f.api('/chats', { kind: 'direct', memberIds: ['agent_codex'], clientId: key() })).body;
  const summary = async () => (await f.api('/bootstrap')).body.threads.find(item => item.id === chat.id);
  assert.equal((await summary()).unreadCount, 0);
  const before = f.store.require('thread', chat.id).updatedAt;
  f.store.updateThread(chat.id, thread => thread.messages.push(
    { id: 'outgoing', role: 'user', text: 'hello', createdAt: '2026-11-12T00:00:00Z' },
    { id: 'incoming-one', role: 'assistant', text: 'first', createdAt: '2026-11-12T00:00:00Z' },
    { id: 'system-event', role: 'system', text: 'scheduled', createdAt: '2026-11-12T00:00:00Z' },
  ));
  assert.equal((await summary()).unreadCount, 1);
  assert.equal((await f.api(`/threads/${chat.id}`)).body.unreadCount, 1, 'fetching a transcript is not reading it');
  const activity = (await summary()).updatedAt;
  assert.notEqual(activity, before);
  // A second response arrives after the renderer obtained its first snapshot.
  f.store.updateThread(chat.id, thread => thread.messages.push({ id: 'incoming-two', role: 'assistant', text: 'second', createdAt: '2026-11-12T00:00:00Z' }));
  const updatedAt = (await summary()).updatedAt;
  const first = await f.api(`/threads/${chat.id}/read`, { messageId: 'incoming-one' });
  assert.equal(first.status, 200);
  assert.equal(first.body.unreadCount, 1, 'a snapshot cannot consume a later reply');
  assert.equal((await summary()).updatedAt, updatedAt, 'reading must not reorder chats');
  const last = await f.api(`/threads/${chat.id}/read`, { messageId: 'incoming-two' });
  assert.equal(last.body.unreadCount, 0);
  assert.equal((await f.api(`/threads/${chat.id}/read`, { messageId: 'incoming-one' })).body.unreadCount, 0);
  assert.equal((await f.api(`/threads/${chat.id}/read`, { messageId: 'missing' })).status, 400);
  assert.equal((await f.api(`/threads/${chat.id}/read`, { messageId: 'outgoing' })).status, 400);
  assert.equal((await f.api(`/threads/${chat.id}/read`, { messageId: 'system-event' })).status, 400);
  await f.restart();
  assert.equal((await summary()).unreadCount, 0);
  f.store.updateThread(chat.id, thread => thread.messages.push({ id: 'incoming-three', role: 'assistant', text: 'after restart', createdAt: '2026-11-12T00:00:00Z' }));
  assert.equal((await summary()).unreadCount, 1);
  await f.restart();
  assert.equal((await summary()).unreadCount, 1, 'restarting cannot reset unread replies');
});

test('first unread upgrade baselines old transcripts once and counts subsequent group replies', async t => {
  const f = await fixture(t);
  const chat = (await f.api('/chats', { kind: 'group', title: 'Group unread', memberIds: ['agent_codex'], clientId: key() })).body;
  f.store.updateThread(chat.id, thread => thread.messages.push({ id: 'legacy-reply', role: 'assistant', text: 'old', createdAt: '2026-11-12T00:00:00Z' }));
  f.store.delete('setting', 'unread-migration-v1');
  await f.restart();
  assert.equal((await f.api(`/threads/${chat.id}`)).body.unreadCount, 0);
  f.store.updateThread(chat.id, thread => thread.messages.push(
    { id: 'group-a', role: 'assistant', text: 'a', createdAt: '2026-11-12T00:00:00Z' },
    { id: 'group-b', role: 'assistant', text: 'b', createdAt: '2026-11-12T00:00:00Z' },
  ));
  assert.equal((await f.api(`/threads/${chat.id}`)).body.unreadCount, 2);
});

test('selected avatar survives rename, discovery and restart; accepted replies keep their original identity', async t => {
  const f = await fixture(t);
  const avatar = { version: 1, style: 'bottts', seed: 'my-agent', palette: 'orange', eyes: 'happy', mouth: 'smile02', top: 'radar', motion: false };
  const created = await f.api('/contacts', { clientId: key(), kind: 'agent', name: '研究员', handle: 'avatar-researcher', binding: { type: 'local', localAgentId: 'codex' }, avatar });
  assert.equal(created.status, 201); assert.deepEqual(created.body.avatar, avatar);
  const chat = (await f.api('/chats', { clientId: key(), kind: 'direct', memberIds: [created.body.id] })).body;
  await f.api(`/threads/${chat.id}/messages`, { clientId: key(), text: '保存这个身份' });
  await f.wait(chat.id, thread => thread.runs[0]?.status === 'completed');
  const updated = await f.api(`/contacts/${created.body.id}`, { clientId: key(), version: created.body.version, name: '新名字', avatar: { ...avatar, seed: 'next-avatar' } });
  assert.equal(updated.status, 200);
  assert.equal((await f.api(`/threads/${chat.id}`)).body.runs[0].contactSnapshot.avatar.seed, 'my-agent');
  await f.restart();
  const restored = (await f.api(`/contacts/${created.body.id}`)).body;
  assert.equal(restored.avatar.seed, 'next-avatar'); assert.equal(restored.name, '新名字');
  assert.equal(restored.avatarActivity.state, 'completed');
  assert.equal((await f.api(`/contacts/${created.body.id}`, { clientId: key(), version: restored.version, avatar: { ...avatar, seed: '' } })).status, 400);
  assert.equal((await f.api(`/contacts/${created.body.id}`)).body.avatar.seed, 'next-avatar');
});

test('explicit provider avatar remains null in accepted history and after ordinary edits', async t => {
  const f = await fixture(t);
  const contact = (await f.api('/contacts', { clientId: key(), kind: 'agent', name: '原助手', handle: 'provider-portrait', binding: { type: 'local', localAgentId: 'codex' }, avatar: null })).body;
  const chat = (await f.api('/chats', { clientId: key(), kind: 'direct', memberIds: [contact.id] })).body;
  await f.api(`/threads/${chat.id}/messages`, { clientId: key(), text: '保持原头像' });
  const result = await f.wait(chat.id, thread => thread.runs[0]?.status === 'completed');
  assert.equal(result.runs[0].contactSnapshot.avatar, null);
  const edited = (await f.api(`/contacts/${contact.id}`, { clientId: key(), version: contact.version, name: '只改名字' })).body;
  assert.equal(edited.avatar, null);
});
