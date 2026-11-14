import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createPersonalServer } from './index.mjs';

let sequence = 0;
const key = () => `participation-${++sequence}`;
const profile = { agentId: 'codex', defaults: { provider: 'openai', model: 'test-model', thinking: 'low' }, models: [], providers: ['openai'], thinkingLevels: ['low'], version: 'fixture-1' };
async function fixture(t, execute = () => ({ action: 'silence', reason: '没有需要补充的内容' }), options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agentstudio-participation-'));
  const changes = new EventEmitter(), contexts = [];
  const app = await createPersonalServer({ dataDir: dir, port: 0, codexCommand: process.execPath,
    discoverLocalAgents: async () => ({ checkedAt: new Date().toISOString(), agents: [{ id: 'codex', name: 'Codex', installed: true, auth: { status: 'configured' }, execution: { supported: true }, profile }] }),
    executeLocalAgent: async input => {
      const context = JSON.parse(input.prompt.split('<untrusted_thread_context>\n')[1].split('\n</untrusted_thread_context>')[0]);
      contexts.push(context);
      const result = await execute(context, input);
      return { markdown: typeof result === 'string' ? result : JSON.stringify(result), identity: { agentId: 'codex' } };
    }, onChange: () => changes.emit('change'), ...options });
  await app.listen();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const wait = (id, predicate) => new Promise((resolve, reject) => {
    const check = () => { const thread = app.store.get('thread', id); if (predicate(thread)) { clearTimeout(timer); changes.off('change', check); resolve(thread); } };
    const timer = setTimeout(() => { changes.off('change', check); reject(new Error(`Timed out: ${JSON.stringify(app.store.get('thread', id)?.runs)}`)); }, 5000);
    changes.on('change', check); check();
  });
  await api('/contacts');
  return { app, api, wait, contexts };
}
const contact = async (f, handle) => (await f.api('/contacts', { kind: 'agent', name: handle, handle, instructions: `职责 ${handle}`, binding: { type: 'local', localAgentId: 'codex' }, clientId: key() })).body;
const group = async (f, members) => {
 if (new Set(members.filter(id=>id!=='self')).size<2) {
  const person=(await f.api('/contacts',{kind:'human',name:'旁听伙伴',handle:'peer-'+key(),clientId:key()})).body;
  members=[...members,person.id];
 }
 return (await f.api('/chats',{kind:'group',title:'协作',memberIds:members,clientId:key()})).body;
};
const send = (f, chat, text, extra = {}) => f.api(`/threads/${chat.id}/messages`, { text, clientId: key(), ...extra });

test('a persona may react without an assistant message or document, acknowledging its exact input', async t => {
  const f = await fixture(t, () => ({ action: 'reaction', emoji: '👍' }));
  const chat = await group(f, ['agent_codex']);
  await send(f, chat, '收到就好');
  const done = await f.wait(chat.id, x => ['completed', 'blocked'].includes(x.runs[0]?.status));
  assert.equal(done.runs[0].status, 'completed');
  assert.equal(done.messages.length, 1); assert.equal(done.artifacts.length, 0);
  assert.equal(done.messages[0].reactions[0].emoji, '👍');
  assert.equal(done.messages[0].reactions[0].contactId, 'agent_codex');
  assert.equal(done.runs[0].inputReceipt.state, 'acknowledged');
  assert.deepEqual(done.runs[0].inputReceipt.messageIds, [done.messages[0].id]);
  assert.equal(f.contexts.length, 1);
  await f.api(`/threads/${chat.id}/retry`, { runId: done.runs[0].id, clientId: key() });
  const retried = await f.wait(chat.id, x => x.runs.length === 2 && x.runs[1].status === 'completed');
  assert.equal(retried.messages[0].reactions.length, 1);
});

test('IM silence defaults on, is versioned, and accepted runs retain their setting', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async () => { entered(); await gate; return { action: 'silence', reason: '已阅，无需补充' }; });
  const setting = await f.api('/im/settings');
  assert.equal(setting.body.allowSilence, true);
  const chat = await group(f, ['agent_codex']);
  await send(f, chat, '第一条'); await started;
  const changed = await f.api('/im/settings', { version: setting.body.version, allowSilence: false, clientId: key() });
  assert.equal(changed.status, 200);
  assert.equal((await f.api('/im/settings', { version: setting.body.version, allowSilence: true, clientId: key() })).status, 409);
  release();
  const first = await f.wait(chat.id, x => x.runs[0]?.status === 'completed');
  assert.equal(first.runs[0].imPolicy.allowSilence, true);
  await send(f, chat, '第二条');
  const second = await f.wait(chat.id, x => x.runs.length === 2 && ['completed', 'blocked'].includes(x.runs[1].status));
  assert.equal(second.runs[1].status, 'blocked');
  assert.match(second.runs[1].error, /静默/);
  assert.equal(second.runs[1].inputReceipt.state, 'supplied');
});

test('group silence override and direct IM reaction preserve plain Markdown compatibility', async t => {
  const f = await fixture(t, context => context.messages.at(-1).text === '正文' ? '自然的文字回复' : { action: 'reaction', emoji: '❤️' });
  const chat = (await f.api('/chats', { kind: 'direct', memberIds: ['agent_codex'], clientId: key() })).body;
  await send(f, chat, '正文');
  await f.wait(chat.id, x => x.runs[0]?.status === 'completed');
  await send(f, chat, '谢谢');
  const done = await f.wait(chat.id, x => x.runs.length === 2 && ['completed', 'blocked'].includes(x.runs[1].status));
  assert.equal(done.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(done.messages.at(-1).reactions[0].emoji, '❤️');
  const g = await group(f, ['agent_codex']);
  const saved = await f.api(`/chats/${g.id}`, { version: g.version, allowSilence: false, clientId: key() });
  assert.equal(saved.body.allowSilence, false);
});

test('dispatch reads already published peers from the same input without reading a later owner message', async t => {
  const f = await fixture(t, context => ({ action: 'reply', text: `${context.agentIdentity.handle}已补充` }), { maxConcurrentRuns: 1 });
  const a = await contact(f, 'researcher'), b = await contact(f, 'writer');
  const chat = await group(f, [a.id, b.id]);
  await send(f, chat, '原问题');
  await f.wait(chat.id, x => x.runs.length === 2 && x.runs.every(r => r.status === 'completed'));
  assert.equal(f.contexts[1].messages.some(m => m.text === 'researcher已补充'), true);
});

test('owner reactions are reversible, validated and idempotent', async t => {
  const f = await fixture(t), chat = await group(f, ['agent_codex']);
  const sent = await send(f, chat, '想法');
  await f.wait(chat.id, x => x.runs[0]?.status === 'completed');
  const input = { messageId: sent.body.messages[0].id, emoji: '🎉', active: true, clientId: key() };
  assert.equal((await f.api(`/threads/${chat.id}/reactions`, input)).status, 200);
  assert.equal((await f.api(`/threads/${chat.id}/reactions`, input)).status, 200);
  assert.equal(f.app.store.require('thread', chat.id).messages[0].reactions.length, 1);
  assert.equal((await f.api(`/threads/${chat.id}/reactions`, { ...input, emoji: 'not-emoji', clientId: key() })).status, 400);
  assert.equal((await f.api(`/threads/${chat.id}/reactions`, { ...input, active: false, clientId: key() })).status, 200);
  assert.equal(f.app.store.require('thread', chat.id).messages[0].reactions.length, 0);
  assert.equal(f.contexts.length, 1, 'reactions never dispatch a model');
});

test('a removed and rejoined actor cannot publish an old reaction into the new membership', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const f = await fixture(t, async context => { if (context.agentIdentity.handle === 'researcher') { entered(); await gate; return { action: 'reaction', emoji: '👀' }; } return { action: 'silence', reason: '无需补充' }; });
  const a = await contact(f, 'researcher'), b = await contact(f, 'writer'), chat = await group(f, [a.id, b.id]);
  await send(f, chat, '旧成员期间的消息'); await started;
  const removed = (await f.api(`/chats/${chat.id}`, { version: chat.version, memberIds: [b.id], clientId: key() })).body;
  await f.api(`/chats/${chat.id}`, { version: removed.version, memberIds: [a.id, b.id], clientId: key() });
  release();
  const done = await f.wait(chat.id, x => ['completed', 'blocked'].includes(x.runs.find(r => r.contactId === a.id).status));
  assert.equal(done.runs.find(r => r.contactId === a.id).status, 'blocked');
  assert.equal(done.messages[0].reactions?.length || 0, 0);
});

test('a reaction cannot bypass final artifact audience authorization', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const f = await fixture(t, async () => { entered(); await gate; return { action: 'reaction', emoji: '✅' }; });
  const chat = await group(f, ['agent_codex']); await send(f, chat, '检查资料'); await started;
  f.app.worker.options.creationService.canPublishConversation = () => false;
  release();
  const done = await f.wait(chat.id, x => x.runs[0]?.status === 'blocked');
  assert.equal(done.messages[0].reactions?.length || 0, 0);
  assert.equal(done.runs[0].inputReceipt.state, 'supplied');
});

test('remote read-only reconciliation acknowledges only the context actually submitted', async t => {
  let completed = false, submitted;
  const remote = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.method === 'message/send') submitted = JSON.parse(rpc.params.message.parts[0].text).context.messages.map(message => message.id);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'task', id: 'original-task', status: { state: completed ? 'completed' : 'working' }, ...(completed ? { artifacts: [{ parts: [{ kind: 'text', text: '合成核查回执' }] }] } : {}) } }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(async () => { remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); });
  const f = await fixture(t, () => ({ action: 'reply', text: '稍后发布的同轮补充' }), { remoteWaitMs: 1 });
  const connection = (await f.api('/connections', { type: 'a2a', name: 'Synthetic remote', url: `http://127.0.0.1:${remote.address().port}` })).body;
  const contacts = (await f.api('/contacts')).body.contacts, remoteContact = contacts.find(contact => contact.binding?.connectionId === connection.id);
  const chat = await group(f, [remoteContact.id, 'agent_codex']);
  await send(f, chat, '原始问题');
  const unknown = await f.wait(chat.id, thread => thread.runs.some(run => run.status === 'unknown') && thread.runs.some(run => run.status === 'completed'));
  const run = unknown.runs.find(run => run.contactId === remoteContact.id);
  assert.deepEqual(run.inputReceipt.messageIds, submitted);
  completed = true;
  await f.api(`/threads/${chat.id}/reconcile`, { runId: run.id, clientId: key() });
  const done = await f.wait(chat.id, thread => thread.runs.every(run => run.status === 'completed'));
  assert.equal(done.runs.find(item => item.id === run.id).inputReceipt.state, 'acknowledged');
  assert.deepEqual(done.runs.find(item => item.id === run.id).inputReceipt.messageIds, submitted);
});

test('default group delivery lets each member choose a real reply or silence without creating phantom messages', async t => {
  const f = await fixture(t, context => context.agentIdentity.handle === 'researcher' ? { action: 'reply', text: '我来核对来源。' } : { action: 'silence', reason: '让负责研究的伙伴回答。' });
  const a = await contact(f, 'researcher'), b = await contact(f, 'writer');
  const chat = await group(f, [a.id, b.id]);
  const result = await send(f, chat, '这个资料的来源可靠吗？');
  assert.equal(result.body.runs.length, 2);
  const done = await f.wait(chat.id, x => x.runs.length === 2 && x.runs.every(r => r.status === 'completed'));
  assert.equal(done.messages.filter(m => m.role === 'user').length, 1);
  assert.deepEqual(done.messages.filter(m => m.role === 'assistant').map(m => m.text), ['我来核对来源。']);
  assert.equal(done.artifacts.length, 1);
  assert.deepEqual(done.runs.find(r => r.contactId === b.id).participation, { action: 'silence', reason: '让负责研究的伙伴回答。' });
  assert.equal(done.runs.find(r => r.contactId === b.id).progress, undefined);
  assert.equal(done.runs[0].responsePolicy, 'auto');
  assert.equal(f.contexts.length, 2, 'assistant reply does not recursively invoke agents');
  assert.equal(f.contexts[0].attention.explicitlyAddressed, false);
});

test('precise addressing and reply attention are frozen with the run and survive retry', async t => {
  const f = await fixture(t, () => ({ action: 'reply', text: '收到。' }));
  const a = await contact(f, 'researcher'), b = await contact(f, 'writer');
  const chat = await group(f, [a.id, b.id]);
  await send(f, chat, '@researcher，请先核对；@writer-too 不是 writer');
  let done = await f.wait(chat.id, x => x.runs.length === 2 && x.runs.every(r => r.status === 'completed'));
  assert.equal(f.contexts[0].attention.explicitlyAddressed, true);
  assert.equal(f.contexts[1].attention.explicitlyAddressed, false);
  assert.deepEqual(f.contexts[0].attention.addressedContactIds, [a.id]);
  const reply = done.messages.find(m => m.role === 'assistant' && m.contactId === b.id);
  await send(f, chat, '继续吧', { replyTo: reply.id });
  done = await f.wait(chat.id, x => x.runs.length === 4 && x.runs.every(r => r.status === 'completed'));
  assert.equal(f.contexts[2].attention.explicitlyAddressed, false);
  assert.equal(f.contexts[3].attention.replyToContactId, b.id);
  assert.equal(f.contexts[3].attention.explicitlyAddressed, true);
  const original = done.runs[0];
  f.app.store.updateThread(chat.id, x => { x.runs[0].status = 'blocked'; x.runs[0].error = 'Synthetic retry'; });
  await f.api(`/contacts/${a.id}`, { name: 'Renamed', handle: 'renamed', instructions: 'Changed', version: a.version, clientId: key() });
  await f.api(`/chats/${chat.id}`, { version: chat.version, responsePolicies: { [a.id]: 'mention' }, clientId: key() });
  await f.api(`/threads/${chat.id}/retry`, { runId: original.id, clientId: key() });
  const retried = await f.wait(chat.id, x => x.runs.length === 5 && x.runs[4].status === 'completed');
  assert.deepEqual(retried.runs[4].conversationSnapshot.attention, original.conversationSnapshot.attention);
  assert.equal(retried.runs[4].responsePolicy, 'auto');
  assert.equal(f.contexts.at(-1).agentIdentity.handle, 'researcher');
  assert.equal(f.contexts.at(-1).attention.explicitlyAddressed, true);
});

test('explicit mention and manual policies still control dispatch, while always keeps ordinary text output', async t => {
  const f = await fixture(t, context => context.responsePolicy === 'always' ? '始终回复的正文' : { action: 'silence', reason: '无需补充' });
  const a = await contact(f, 'researcher'), b = await contact(f, 'writer'), c = await contact(f, 'coordinator');
  const chat = await group(f, [a.id, b.id, c.id]);
  const policy = await f.api(`/chats/${chat.id}`, { version: chat.version, responsePolicies: { [a.id]: 'mention', [b.id]: 'manual', [c.id]: 'always' }, clientId: key() });
  assert.equal(policy.status, 200);
  await send(f, chat, '日常讨论');
  let done = await f.wait(chat.id, x => x.runs.length === 1 && x.runs[0].status === 'completed');
  assert.equal(done.runs[0].contactId, c.id);
  assert.equal(done.messages.at(-1).text, '始终回复的正文');
  await send(f, chat, '@all 大家看看');
  done = await f.wait(chat.id, x => x.runs.length === 3 && x.runs.every(r => r.status === 'completed'));
  assert.equal(done.runs.some(r => r.contactId === b.id), false);
});

test('protocol envelopes are not exposed as streamed text and malformed decisions remain failures', async t => {
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (_context, input) => {
    input.onEvent({ type: 'progress', phase: 'writing', text: '{"action":"silence","reason":"尚未完整"' });
    entered(); await gate;
    return '{"action":"silence","text":"hidden reply"}';
  });
  const chat = await group(f, ['agent_codex']);
  await send(f, chat, '普通消息');
  await enteredPromise;
  const running = f.app.store.get('thread', chat.id);
  assert.equal(running.runs[0].progress?.text || '', '');
  release();
  const failed = await f.wait(chat.id, x => x.runs[0].status === 'blocked');
  assert.match(failed.runs[0].error, /参与|回复|格式/);
  assert.equal(failed.runs[0].participation, undefined);
  assert.equal(failed.messages.length, 1);
  assert.equal(failed.artifacts.length, 0);
});

test('autonomous delivery preserves post-join history boundaries and skips unavailable ambient members', async t => {
  const f = await fixture(t);
  const chat = await group(f, ['agent_codex']);
  await send(f, chat, 'PRIVATE_BEFORE_JOIN');
  await f.wait(chat.id, x => x.runs[0]?.status === 'completed');
  const later = await contact(f, 'later');
  const unavailable = f.app.store.put('contact', { id: 'agent_absent', kind: 'agent', name: 'Absent', handle: 'absent', description: '', instructions: '', version: 1, binding: { type: 'local', localAgentId: 'absent' } });
  await f.api(`/chats/${chat.id}`, { version: chat.version, memberIds: ['agent_codex', later.id, unavailable.id], clientId: key() });
  f.app.store.updateThread(chat.id, x => x.messages.push({ id: 'late-before-join', role: 'assistant', contactId: 'agent_codex', text: 'PRIVATE_LATE_REPLY', recipientIds: ['self', 'agent_codex'], createdAt: new Date().toISOString() }));
  const sent = await send(f, chat, '加入后的普通消息');
  assert.equal(sent.body.runs.length, 3);
  assert.equal(sent.body.messages.at(-1).skippedContacts[0].id, unavailable.id);
  await f.wait(chat.id, x => x.runs.length === 3 && x.runs.every(r => r.status === 'completed'));
  const received = f.contexts.find(context => context.agentIdentity.id === later.id);
  assert.ok(received);
  assert.ok(!JSON.stringify(received).includes('PRIVATE_BEFORE_JOIN'));
  assert.ok(!JSON.stringify(received).includes('PRIVATE_LATE_REPLY'));
  const rejected = await send(f, chat, '@absent 请回答');
  assert.equal(rejected.status, 409);
  assert.equal(f.app.store.get('thread', chat.id).messages.filter(m => m.role === 'user').length, 2);
});

test('always-policy group output remains unpublished while the model is still producing text', async t => {
  let entered, release; const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (_context, input) => { input.onEvent({ type: 'progress', phase: 'writing', text: 'PRIVATE_STREAM_BEFORE_FINAL_CHECK' }); entered(); await gate; return 'A completed ordinary reply'; });
  const chat = await group(f, ['agent_codex']); await f.api(`/chats/${chat.id}`, { version: chat.version, responsePolicies: { agent_codex: 'always' }, clientId: key() });
  await send(f, chat, 'Please respond'); await ready;
  const during = f.app.store.require('thread', chat.id).runs[0].progress?.text || ''; release(); await f.wait(chat.id, thread => thread.runs[0]?.status === 'completed');
  assert.equal(during, '');
});
