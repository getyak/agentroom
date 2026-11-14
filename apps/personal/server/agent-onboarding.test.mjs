import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore } from './store.mjs';
import { Messenger } from './messenger.mjs';
import { AgentOnboarding } from './agent-onboarding.mjs';

const profile = { agentId: 'codex', defaults: { provider: 'openai', model: 'fixture-model', thinking: 'low' }, providers: ['openai'], models: [], thinkingLevels: ['low'], version: 'fixture-v1' };
const detected = { agents: [{ id: 'codex', name: 'Codex', installed: true, auth: { status: 'configured' }, execution: { supported: true }, profile }] };
const suggestion = sources => ({ suggestions: [{ name: '审查伙伴', handle: 'review-partner', description: '核对变更与风险', instructions: '根据当前讨论核对证据，只在能提供帮助时回应。', rationale: '现有群聊在讨论发布，适合独立审查。', sourceIds: sources.filter(x => x.kind === 'group').slice(0, 1).map(x => x.id), groupIds: sources.filter(x => x.kind === 'group').slice(0, 1).map(x => x.targetId) }], habits: [] });
async function setup(t, execute) {
 const dir = await mkdtemp(join(tmpdir(), 'agentstudio-onboarding-'));
 const store = new PersonalStore(dir); const messenger = new Messenger(store); messenger.sync(detected);
  store.put('contact',{id:'group_peer',kind:'human',name:'讨论伙伴',handle:'group-peer',color:'teal',version:1});
 const group = messenger.createChat({ kind: 'group', title: '发布讨论', memberIds: ['agent_codex','group_peer'] });
 group.messages.push({ id: 'group-message', role: 'user', text: '先检查回归，再发布', createdAt: new Date().toISOString() }); store.put('thread', group);
 const dm = messenger.createChat({ kind: 'direct', memberIds: ['agent_codex'] }); dm.messages.push({ id: 'private-message', role: 'user', text: 'DM_PRIVATE_MUST_NOT_LEAK' }); store.put('thread', dm);
 store.put('memory', { id: 'memory-one', text: '喜欢简短回答' });
 const service = new AgentOnboarding(store, messenger, { execute, deps: {}, notify() {} });
 t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
 return { store, service, group };
}
const start = f => f.service.start({ agentId: 'codex', includeRecentMessages: true, includeMemories: true, goal: '帮我检查发布' }, detected);

test('onboarding projects bounded workspace sources and excludes private chats or opted-out history', async t => {
 const f = await setup(t);
 const context = f.service.context({ includeRecentMessages: true, includeMemories: true });
 assert.ok(JSON.stringify(context).includes('先检查回归'));
 assert.ok(JSON.stringify(context).includes('喜欢简短回答'));
 assert.ok(!JSON.stringify(context).includes('DM_PRIVATE'));
 const minimal = f.service.context({ includeRecentMessages: false, includeMemories: false });
 assert.ok(!JSON.stringify(minimal).includes('先检查回归'));
 assert.ok(!JSON.stringify(minimal).includes('喜欢简短回答'));
 assert.ok(minimal.sources.some(x => x.kind === 'group'));
});

test('a real execution probe must succeed before analysis; snapshots and adoption survive repeated requests', async t => {
 const calls = [];
 const f = await setup(t, async request => {
  calls.push(request);
  if (calls.length === 1) { const challenge = request.prompt.match(/challenge: ([a-zA-Z0-9_-]+)/)[1]; return { markdown: JSON.stringify({ status: 'ok', challenge }) }; }
  const context = JSON.parse(request.prompt.split('<untrusted_onboarding_context>\n')[1].split('\n</untrusted_onboarding_context>')[0]);
  return { markdown: JSON.stringify(suggestion(context.sources)) };
 });
 const job = start(f); assert.equal(job.status, 'queued'); assert.equal(calls.length, 0);
 const thread = f.store.require('thread', job.threadId), run = thread.runs[0];
 f.store.put('memory', { id: 'memory-later', text: 'FUTURE_MEMORY_EXCLUDED' });
 await f.service.execute(thread, run, new AbortController().signal);
 const done = f.service.get(job.id); assert.equal(done.status, 'completed'); assert.equal(done.probe.status, 'passed');
 assert.equal(calls.length, 2); assert.ok(!calls[0].prompt.includes('发布讨论'));
 assert.ok(!calls[1].prompt.includes('FUTURE_MEMORY_EXCLUDED'));
 assert.deepEqual(calls[0].executionSnapshot, calls[1].executionSnapshot);
 const first = f.service.adopt(job.id, done.suggestions[0].id), second = f.service.adopt(job.id, done.suggestions[0].id);
 assert.equal(first.id, second.id); assert.equal(f.store.list('contact').filter(x => x.handle === 'review-partner').length, 1);
 assert.deepEqual(first.configuration, { modelMode: 'fixed', provider: 'openai', model: 'fixture-model', thinking: 'low' });
 assert.equal(f.store.require('thread', f.group.id).memberIds.length, 3);
});

test('wrong challenge, provider failure and malformed recommendations never create adoptable roles', async t => {
 for (const mode of ['challenge', 'provider', 'evidence']) {
  let calls = 0;
  const f = await setup(t, async request => {
   calls++;
   if (mode === 'provider') { const error = new Error('额度不足'); error.code = 'provider_limit'; throw error; }
   const challenge = request.prompt.match(/challenge: ([a-zA-Z0-9_-]+)/)?.[1];
   if (challenge) return { markdown: JSON.stringify({ status: 'ok', challenge: mode === 'challenge' ? 'wrong' : challenge }) };
   return { markdown: JSON.stringify({ suggestions: [{ ...suggestion([]).suggestions[0], sourceIds: ['invented-source'], groupIds: [] }], habits: [] }) };
  });
  const job = start(f), thread = f.store.require('thread', job.threadId);
  await assert.rejects(f.service.execute(thread, thread.runs[0], new AbortController().signal));
  assert.equal(f.service.get(job.id).status, 'failed');
  assert.equal(f.service.get(job.id).suggestions.length, 0);
  assert.equal(calls, mode === 'evidence' ? 2 : 1);
  assert.throws(() => f.service.adopt(job.id, 'whatever'), /完成|建议/);
 }
});

test('recovery makes interrupted preparation explicit and never retries the provider automatically', async t => {
 const f = await setup(t); const job = start(f);
 f.store.put('agent_onboarding', { ...f.store.require('agent_onboarding', job.id), status: 'analyzing' });
 f.service.recover();
 const recovered = f.service.get(job.id);
 assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.suggestions.length, 0);
 assert.equal(f.store.require('thread', job.threadId).runs[0].status, 'blocked');
});

test('HTTP onboarding uses the existing queue, stays out of chats, and adopts exactly once', async t => {
 const { createPersonalServer } = await import('./index.mjs');
 const { EventEmitter } = await import('node:events');
 const changes = new EventEmitter();
 const dir = await mkdtemp(join(tmpdir(), 'onboarding-http-')); let calls = 0;
 const app = await createPersonalServer({ dataDir: dir, port: 0, codexCommand: process.execPath, discoverLocalAgents: async () => detected, onChange: () => changes.emit('change'), executeLocalAgent: async request => {
  calls++; const challenge = request.prompt.match(/challenge: ([a-zA-Z0-9_-]+)/)?.[1];
  if (challenge) return { markdown: JSON.stringify({ status: 'ok', challenge }) };
  const context = JSON.parse(request.prompt.split('<untrusted_onboarding_context>\n')[1].split('\n</untrusted_onboarding_context>')[0]);
  return { markdown: JSON.stringify(suggestion(context.sources)) };
 }});
 await app.listen(); t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
 const api = async (path, body) => { const response = await fetch(`http://127.0.0.1:${app.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json() }; };
 app.store.put('contact',{id:'group_peer',kind:'human',name:'讨论伙伴',handle:'group-peer',version:1});
 await api('/contacts'); await api('/chats', { clientId: 'onboarding-http-group', kind: 'group', title: '验收讨论', memberIds: ['agent_codex','group_peer'] });
 const input = { agentId: 'codex', clientId: 'onboarding-http-start', includeRecentMessages: false, includeMemories: false };
 const accepted = await api('/agent-onboarding', input); assert.equal(accepted.status, 202);
 const done = await new Promise((resolve, reject) => { const check = () => { const job = app.store.get('agent_onboarding', accepted.body.id); if (['completed', 'failed'].includes(job.status)) { clearTimeout(timer); changes.off('change', check); resolve(job); } }; const timer = setTimeout(() => reject(new Error('onboarding queue stalled')), 3000); changes.on('change', check); check(); });
 assert.equal(done.status, 'completed'); assert.equal(calls, 2);
 assert.equal((await api('/agent-onboarding', input)).body.id, done.id); assert.equal(calls, 2);
 assert.ok(!(await api('/bootstrap')).body.threads.some(x => x.id === done.threadId));
 for (const action of ['messages', 'retry', 'cancel']) assert.equal((await api(`/threads/${done.threadId}/${action}`, { clientId: `forbidden-hidden-${action}`, text: 'must not enter ordinary thread dispatch' })).status, 409);
 assert.equal(app.store.require('agent_onboarding', done.id).status, 'completed');
 const adoption = { clientId: 'onboarding-http-adopt', suggestionId: done.suggestions[0].id };
 const first = await api(`/agent-onboarding/${done.id}/adopt`, adoption), again = await api(`/agent-onboarding/${done.id}/adopt`, { ...adoption, clientId: 'onboarding-http-adopt-again' });
 assert.equal(first.status, 200); assert.equal(first.body.id, again.body.id);
});

test('onboarding propagates uncertain stop and rechecks a barrier that appeared after queueing', async t => {
 const f = await setup(t, async () => { const error = new Error('停止尚未确认'); error.code = 'stop_unconfirmed'; throw error; });
 const job = start(f), thread = f.store.require('thread', job.threadId);
 await assert.rejects(f.service.execute(thread, thread.runs[0], new AbortController().signal), error => error.stopUnconfirmed === true);
 assert.equal(f.service.get(job.id).status, 'interrupted');
 let calls = 0;
 const other = await setup(t, async () => { calls++; throw new Error('must not start'); });
 const queued = start(other), pending = other.store.require('thread', queued.threadId);
 const barrier = other.store.createThread({ text: '停止状态未知', mode: 'codex', localAgentId: 'codex', attachments: [] });
 barrier.runs[0].status = 'unknown'; barrier.runs[0].stopUnconfirmed = true; other.store.put('thread', barrier);
 await assert.rejects(other.service.execute(pending, pending.runs[0], new AbortController().signal), /停止状态尚未确认/);
 assert.equal(calls, 0);
});

 test('suggested handles respect human contacts as well as existing agents', async t => {
  const f = await setup(t);
  f.service.messenger.saveContact({kind:'human',name:'朋友',handle:'friend'});
  const context = f.service.context(); assert.ok(context.unavailableHandles.includes('friend'));
  const job = start(f), result = suggestion(context.sources); result.suggestions[0].handle = 'friend';
  assert.throws(() => f.service.validate(result, f.store.require('agent_onboarding',job.id)), /用户名重复/);
 });

test('HTTP cancel handles queued and running jobs atomically and preserves an uncertain stop barrier', async t => {
 const { createPersonalServer } = await import('./index.mjs');
 const { EventEmitter } = await import('node:events');
 const changes = new EventEmitter(), dir = await mkdtemp(join(tmpdir(), 'onboarding-cancel-'));
 const installed = structuredClone(detected);
 installed.agents.push({ ...installed.agents[0], id: 'claude', name: 'Claude', profile: { ...profile, agentId: 'claude', defaults: { ...profile.defaults, provider: 'anthropic' }, providers: ['anthropic'] } });
 const calls = [];
 const app = await createPersonalServer({ dataDir: dir, port: 0, maxConcurrentRuns: 1, codexCommand: process.execPath, discoverLocalAgents: async () => installed, onChange: () => changes.emit('change'), executeLocalAgent: request => {
  calls.push(request.id);
  return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => { const error = new Error('合成停止未确认'); error.code = 'stop_unconfirmed'; reject(error); }, { once: true }));
 }});
 await app.listen(); t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
 const api = async (path, body) => { const r = await fetch(`http://127.0.0.1:${app.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
 const wait = predicate => new Promise((resolve, reject) => { const check = () => { if (predicate()) { clearTimeout(timer); changes.off('change', check); resolve(); } }; const timer = setTimeout(() => { changes.off('change', check); reject(new Error('cancel state did not settle')); }, 3000); changes.on('change', check); check(); });
 const running = (await api('/agent-onboarding', { clientId: 'cancel-running-start', agentId: 'codex' })).body;
 await wait(() => app.store.get('agent_onboarding', running.id).status === 'probing');
 const queued = (await api('/agent-onboarding', { clientId: 'cancel-queued-start', agentId: 'claude' })).body;
 assert.equal(queued.status, 'queued');
 const cancelled = await api(`/agent-onboarding/${queued.id}/cancel`, { clientId: 'cancel-queued-request' });
 assert.equal(cancelled.status, 200); assert.equal(cancelled.body.status, 'cancelled'); assert.equal(cancelled.body.cancelPending, false); assert.deepEqual(calls, ['codex']);
 const body = { clientId: 'cancel-running-request' };
 const stopping = await api(`/agent-onboarding/${running.id}/cancel`, body); assert.equal(stopping.status, 200); assert.equal(stopping.body.cancelPending, true);
 await wait(() => app.store.require('thread', running.threadId).runs[0].stopUnconfirmed === true);
 assert.equal(app.store.require('thread', running.threadId).runs[0].status, 'unknown');
 assert.equal(app.store.require('agent_onboarding', running.id).status, 'interrupted');
 assert.equal((await api(`/agent-onboarding/${running.id}/cancel`, body)).status, 200);
 assert.equal((await api('/agent-onboarding', { clientId: 'cancel-must-not-restart', agentId: 'codex' })).status, 409);
 assert.deepEqual(calls, ['codex']);
});

test('restart during cancellation exposes interrupted preparation and preserves the stop barrier', async t => {
 const f = await setup(t), job = start(f);
 f.service.cancel(job.id);
 const thread = f.store.require('thread', job.threadId); thread.runs[0].cancelPending = true; f.store.put('thread', thread);
 f.store.recover(); f.service.recover();
 const recovered = f.service.get(job.id);
 assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.cancelPending, false); assert.equal(recovered.stopUnconfirmed, true);
 assert.equal(f.store.require('thread', job.threadId).runs[0].status, 'unknown');
});

test('agent-selected avatar parameters are validated and adopted without changing their seed', async t => {
 const f = await setup(t); const job = start(f); const stored = f.store.require('agent_onboarding', job.id);
 const result = suggestion(stored.context.sources);
 const avatar = { version: 1, style: 'bottts', seed: 'review-companion-1', palette: 'orange', eyes: 'eva', mouth: 'diagram', top: 'pyramid', motion: true };
 result.suggestions[0].avatar = avatar;
 const parsed = f.service.validate(result, stored);
 f.store.put('agent_onboarding', { ...stored, status: 'completed', probe: { status: 'passed' }, ...parsed });
 assert.deepEqual(f.service.adopt(job.id, parsed.suggestions[0].id).avatar, avatar);
 result.suggestions[0].avatar = { ...avatar, top: 'arbitrary-svg' };
 // Use an unused handle so appearance validation is the failing condition.
 result.suggestions[0].handle = 'another-reviewer';
 assert.throws(() => f.service.validate(result, stored), /头像/);
});
