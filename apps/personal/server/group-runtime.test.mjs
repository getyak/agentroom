import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createPersonalServer } from './index.mjs';
const detected = { agents: [{ id: 'codex', name: 'Codex', installed: true, auth: { status: 'configured' }, execution: { supported: true } }] };
async function fixture(t, execute) {
  const dir = await mkdtemp(join(tmpdir(), 'group-runtime-')), changes = new EventEmitter(); let homesClosed = 0;
  const host = await createPersonalServer({ autoGroupNetwork: false, dataDir: dir, port: 0, discoverLocalAgents: async () => detected, executeLocalAgent: execute, guestSession: async () => ({ deps: { env: { HOME: '/isolated-fixture' } }, close: () => homesClosed++ }), onChange: () => changes.emit('change') });
  await host.listen(); host.playrooms.messenger.sync(detected);
  t.after(async () => { await host.close(); await rm(dir, { recursive: true, force: true }); });
  const contact = host.store.require('contact', 'agent_codex'); host.store.put('contact', { ...contact, instructions: 'PRIVATE_ROLE' });
  host.store.put('contact',{id:'group_peer',kind:'human',name:'讨论伙伴',handle:'group-peer',color:'teal',version:1});
  const thread = host.playrooms.messenger.createChat({ kind: 'group', title: '共享周末', memberIds: ['agent_codex','group_peer'] });
  thread.messages.push({ id: 'old', role: 'user', text: 'PRIVATE_HISTORY', contactId: 'self' }); host.store.put('thread', thread);
  const room = host.playrooms.prepare(thread.id, { brief: 'PUBLIC_BRIEF', agents: [{ contactId: contact.id, persona: 'PUBLIC_ROLE' }], clientId: crypto.randomUUID() }); host.playrooms.publish(thread.id, { shareId: room.id, clientId: crypto.randomUUID(), version: room.share.version });
  const wait = predicate => new Promise((resolve, reject) => { const check = () => { const current = host.store.require('thread', thread.id); if (predicate(current)) { clearTimeout(timer); changes.off('change', check); resolve(current); } }; const timer = setTimeout(() => { changes.off('change', check); reject(new Error(JSON.stringify(host.store.require('thread', thread.id).runs))); }, 5000); changes.on('change', check); check(); });
  return { host, thread, room, wait, closed: () => homesClosed };
}
test('shared owner queries use native tools and isolated context with no private fallback', async t => {
  let seen;
  const f = await fixture(t, async input => { seen = input; return { markdown: '{"action":"reply","text":"公开结果"}' }; });
  f.host.playrooms.send(f.thread.id, 'self', { text: '帮我整理' });
  const done = await f.wait(thread => thread.runs[0]?.status === 'completed');
  assert.equal(seen.isolateUserContext, true); assert.ok(seen.toolSession); assert.equal(seen.deps.env.HOME, '/isolated-fixture');
  assert.ok(seen.prompt.includes('PUBLIC_ROLE')); assert.ok(!seen.prompt.includes('PRIVATE_')); assert.ok(seen.prompt.includes('group_info'));
  assert.equal(f.closed(), 1); assert.equal(done.messages.at(-1).text, '公开结果');
  assert.deepEqual(seen.toolSession.toolNames, ['group_info', 'group_artifact_list', 'group_artifact_create', 'group_artifact_edit']);
});
test('an unsupported public CLI fails once and never retries through the ordinary private path', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; const error = new Error('fixture old CLI'); error.code = 'unsupported_cli_version'; throw error; });
  f.host.playrooms.send(f.thread.id, 'self', { text: '等待' });
  await f.wait(thread => thread.runs[0]?.status === 'blocked'); assert.equal(calls, 1); assert.equal(f.closed(), 1);
});
