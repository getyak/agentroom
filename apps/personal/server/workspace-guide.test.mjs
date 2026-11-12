import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createPersonalServer } from './index.mjs';

const agent = (id, patch = {}) => ({ id, name: id, installed: true, auth: { status: 'configured' }, execution: { supported: true },
  profile: { agentId: id, defaults: { provider: 'synthetic', model: 'fixture-model', thinking: 'medium' }, models: [], providers: ['synthetic'], thinkingLevels: ['medium'], modelThinkingLevels: {}, fingerprint: 'fixture' }, ...patch });

async function setup(t, agents = [], options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'roo-guide-'));
  let app;
  const start = async () => {
    app = await createPersonalServer({ dataDir: dir, port: 0, codexCommand: '/missing-roo-synthetic', discoverLocalAgents: async () => ({ agents, checkedAt: new Date().toISOString() }), ...options });
    await app.listen(); return app;
  };
  await start();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const get = async path => (await fetch(`http://127.0.0.1:${app.address().port}/api${path}`)).json();
  return { get, get app() { return app; }, agents, restart: async () => { await app.close(); await start(); } };
}

test('fresh workspace has one real guide conversation without executing a model', async t => {
  const s = await setup(t, [agent('codex'), agent('claude')]);
  const boot = await s.get('/bootstrap');
  assert.equal(boot.workspace.guide.contactId, 'agentroom_guide');
  assert.equal(boot.workspace.guide.agentId, 'codex');
  assert.equal(boot.workspace.guide.executionVerified, false);
  const contact = (await s.get('/contacts')).contacts.find(c => c.systemRole === 'guide');
  assert.equal(contact.name, '阿屋 Roo'); assert.equal(contact.avatar, null);
  assert.equal(contact.availability, 'ready');
  const thread = await s.get(`/threads/${boot.workspace.guide.threadId}`);
  assert.equal(thread.messages.length, 1); assert.equal(thread.runs.length, 0);
  assert.match(thread.messages[0].text, /阿屋/);
  await Promise.all([s.get('/bootstrap'), s.get('/contacts'), s.get('/bootstrap')]);
  await s.restart();
  const again = await s.get('/bootstrap');
  assert.equal(again.workspace.guide.threadId, thread.id);
  assert.equal((await s.get(`/threads/${thread.id}`)).messages.length, 1);
  assert.equal(again.workspace.onboardingCompleted, false);
});

test('guide skips login, unsupported adapters and invalid model settings; honors owner default', async t => {
  const s = await setup(t, [agent('codex', { auth: { status: 'required' } }), agent('pi', { profile: null }), agent('claude')]);
  assert.equal((await s.get('/bootstrap')).workspace.guide.agentId, 'claude');
  const next = await setup(t, [agent('codex'), agent('claude')]);
  next.app.store.put('setting', { id: 'local-agent', agentId: 'claude' });
  assert.equal((await next.get('/bootstrap')).workspace.guide.agentId, 'claude');
});

test('missing backend still offers a guide, binds when configured, and never silently switches', async t => {
  const s = await setup(t);
  const guide = (await s.get('/bootstrap')).workspace.guide;
  assert.equal(guide.agentId, null); assert.match(guide.reason, /连接/);
  s.agents.push(agent('claude'));
  assert.equal((await s.get('/bootstrap')).workspace.guide.agentId, 'claude');
  s.agents[0].auth.status = 'required'; s.agents.push(agent('codex'));
  assert.equal((await s.get('/bootstrap')).workspace.guide.agentId, 'claude');
  assert.equal((await s.get('/contacts')).contacts.find(c => c.id === guide.contactId).availability, 'login_required');
});

test('populated workspace keeps its normal entry; reopening deliberately creates Roo', async t => {
  const s = await setup(t, [agent('codex')]);
  s.app.store.put('memory', { id: 'private', text: 'private secret fixture' });
  await s.restart();
  assert.equal((await s.get('/bootstrap')).workspace.guide, null);
  s.app.store.put('setting', { id: 'workspace-onboarding', completed: false });
  assert.equal((await s.get('/bootstrap')).workspace.guide.agentId, 'codex');
  assert.equal(s.app.store.get('memory', 'private').text, 'private secret fixture');
});

test('guide context is bounded facts, never private history or raw configuration', async t => {
  const s = await setup(t, [agent('codex')]);
  await s.get('/bootstrap');
  s.app.store.put('memory', { id: 'private', text: 'private secret fixture' });
  s.app.store.put('connection', { id: 'connection-fixture', type: 'mcp', name: 'safe tool', url: 'https://fixture.invalid/?token=private-token', credentialRef: 'private-credential' });
  await s.get('/contacts');
  const { guideContext } = await import('./workspace-guide.mjs');
  const context = guideContext(s.app.store);
  const encoded = JSON.stringify(context);
  assert.match(encoded, /codex/); assert.match(encoded, /safe tool/);
  for (const secret of ['private secret fixture', 'private-token', 'private-credential', 'https://fixture.invalid']) assert.equal(encoded.includes(secret), false);
  assert.equal(context.executionVerified, false);
});

test('reopening a populated workspace preserves an existing roo handle', async t => {
  const s = await setup(t, [agent('codex')]);
  s.app.store.put('contact', { id: 'owner-roo', kind: 'human', name: 'Roo 原联系人', handle: 'roo', version: 1, binding: null });
  s.app.store.put('contact', { id: 'owner-roo-2', kind: 'human', name: '第二位联系人', handle: 'roo-2', version: 1, binding: null });
  await s.restart();
  s.app.store.put('setting', { id: 'workspace-onboarding', completed: false });
  await s.get('/bootstrap');
  const contacts = (await s.get('/contacts')).contacts;
  assert.equal(contacts.find(c => c.id === 'owner-roo').handle, 'roo');
  assert.equal(contacts.find(c => c.systemRole === 'guide').handle, 'roo-3');
  assert.equal(new Set(contacts.map(c => c.handle)).size, contacts.length);
});

test('interrupted guide seeding rolls back every record and retry creates one introduction', async t => {
  const s = await setup(t, [agent('codex')]);
  const original = s.app.store.put.bind(s.app.store);
  s.app.store.put = (kind, record) => {
    if (kind === 'setting' && record.id === 'workspace-guide') throw new Error('Synthetic seed interruption');
    return original(kind, record);
  };
  const response = await s.get('/bootstrap');
  assert.equal(response.error.code, 'internal_error');
  assert.equal(s.app.store.get('contact', 'agentroom_guide'), null);
  assert.equal(s.app.store.get('setting', 'workspace-onboarding'), null);
  assert.equal(s.app.store.list('thread').length, 0);
  s.app.store.put = original;
  const guide = (await s.get('/bootstrap')).workspace.guide;
  assert.equal((await s.get(`/threads/${guide.threadId}`)).messages.length, 1);
});

test('real chat pipeline supplies Roo its accepted identity and safe discovery snapshot', async t => {
  const changes = new EventEmitter(); let received;
  const s = await setup(t, [agent('codex')], { onChange: () => changes.emit('change'), executeLocalAgent: async input => {
    received = input;
    return { markdown: '先看看这台电脑上有哪些伙伴吧。' };
  } });
  const guide = (await s.get('/bootstrap')).workspace.guide;
  assert.equal(received, undefined);
  const completed = new Promise((resolve, reject) => {
    const check = () => { const thread = s.app.store.get('thread', guide.threadId); if (thread.runs.at(-1)?.status === 'completed') { clearTimeout(timer); changes.off('change', check); resolve(thread); } };
    const timer = setTimeout(() => { changes.off('change', check); reject(new Error('Guide reply did not finish')); }, 8000);
    changes.on('change', check);
  });
  const response = await fetch(`http://127.0.0.1:${s.app.address().port}/api/threads/${guide.threadId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '帮我认识这台电脑', clientId: 'guide-chat-fixture' }),
  });
  assert.equal(response.status, 200);
  const thread = await completed;
  assert.equal(received.id, 'codex'); assert.equal(received.executionSnapshot.model, 'fixture-model');
  const context = JSON.parse(received.prompt.split('<untrusted_thread_context>\n')[1].split('\n</untrusted_thread_context>')[0]);
  assert.equal(context.agentIdentity.systemRole, 'guide');
  assert.equal(context.guide.agents[0].id, 'codex');
  assert.equal(thread.messages.at(-1).text, '先看看这台电脑上有哪些伙伴吧。');
});
