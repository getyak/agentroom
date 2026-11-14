import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore } from './store.mjs';
import { Playrooms } from './playrooms.mjs';

const contact = { id: 'agent_test', name: '小熊', kind: 'agent', availability: 'ready', binding: { type: 'local', localAgentId: 'pi' }, instructions: 'PRIVATE_PERSONA', configuration: {} };
async function fixture(t, execute = async context => `你好 ${context.messages.at(-1).text}`) {
  const dir = await mkdtemp(join(tmpdir(), 'playrooms-')); let clock = Date.now();
  const store = new PersonalStore(dir); store.put('memory', { id: 'private', text: 'PRIVATE_MEMORY' });
  const rooms = new Playrooms(store, { execute, now: () => clock, port: 0 }); await rooms.listen();
  t.after(async () => { await rooms.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${rooms.server.address().port}`;
  const create = (extra = {}) => rooms.create({ template: 'travel', title: '去山那边', brief: '共享预算600元', persona: '合成旅行伙伴', clientId: crypto.randomUUID(), ...extra }, contact);
  const request = async (path, body, cookie, headers = {}) => {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', Origin: origin }), ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers, body: await response.json() };
  };
  const enter = async (room, nickname = '朋友', clientId = crypto.randomUUID()) => request('/g-api/join', { invite: rooms.invitation(room.id).token, nickname, clientId });
  return { dir, store, rooms, request, create, enter, advance: ms => clock += ms };
}
async function settled(f, id) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { const room = f.rooms.owner(id); if (room.jobs.every(j => !['queued', 'running', 'stopping'].includes(j.status))) return room; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Room did not settle');
}
test('anonymous preview publishes only reviewed brief; acceptance gives a scoped HttpOnly identity', async t => {
  const f = await fixture(t), room = f.create(), invitation = f.rooms.invitation(room.id);
  assert.match(invitation.token, /^[A-Za-z0-9_-]{43}$/);
  const preview = await f.request('/g-api/preview', { invite: invitation.token });
  assert.equal(preview.status, 200); assert.equal(preview.body.brief, '共享预算600元'); assert.equal(preview.body.messages, undefined);
  assert.ok(!JSON.stringify(preview.body).includes('PRIVATE_'));
  const guest = await f.enter(room); assert.equal(guest.status, 201); assert.match(guest.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await f.request(`/g-api/${room.id}`, undefined, guest.cookie)).status, 200);
  assert.equal((await f.request(`/g-api/${room.id}`)).status, 401);
  const other = f.create(); assert.equal((await f.request(`/g-api/${other.id}`, undefined, guest.cookie)).status, 401);
  const db = await readFile(join(f.dir, 'personal.sqlite')); assert.ok(!db.includes(Buffer.from(invitation.token)));
  assert.ok(!JSON.stringify(f.rooms.owner(room.id)).includes(invitation.token));
});
test('join retry consumes one slot, preserves distinct same-named identities and caps participants atomically', async t => {
  const f = await fixture(t), room = f.create({ maxGuests: 2 }), clientId = crypto.randomUUID();
  const a = await f.enter(room, '同名朋友', clientId), again = await f.enter(room, '同名朋友', clientId), b = await f.enter(room, '同名朋友');
  assert.equal(a.body.me.id, again.body.me.id); assert.notEqual(a.body.me.id, b.body.me.id);
  assert.equal((await f.enter(room, '第三位')).status, 429);
  assert.equal((await f.enter(room, '改名', clientId)).status, 409);
  assert.equal(f.rooms.owner(room.id).participants.length, 3);
});
test('messages execute once and freeze only room context; output is shared with both guests', async t => {
  const seen = []; const f = await fixture(t, async context => { seen.push(context); return '一起去山间走走。'; });
  const room = f.create(), a = await f.enter(room, '甲'), b = await f.enter(room, '乙');
  const body = { type: 'message', text: '怎么分工？', clientId: crypto.randomUUID() };
  assert.equal((await f.request(`/g-api/${room.id}/actions`, body, a.cookie)).status, 200);
  assert.equal((await f.request(`/g-api/${room.id}/actions`, body, a.cookie)).status, 200);
  assert.equal((await f.request(`/g-api/${room.id}/actions`, { ...body, text: 'changed' }, a.cookie)).status, 409);
  await settled(f, room.id); assert.equal(seen.length, 1); assert.ok(!JSON.stringify(seen).includes('PRIVATE_'));
  const state = await f.request(`/g-api/${room.id}`, undefined, b.cookie); assert.equal(state.body.messages.at(-1).text, '一起去山间走走。');
  assert.ok(!JSON.stringify(state.body).includes('localAgentId'));
});
test('shared votes, checklist and notes persist with identity and reject stale overwrite', async t => {
  const f = await fixture(t), room = f.create(), a = await f.enter(room), b = await f.enter(room);
  const act = (cookie, body) => f.request(`/g-api/${room.id}/actions`, { ...body, clientId: crypto.randomUUID() }, cookie);
  const choice = room.board.choices[0].id, task = room.board.tasks[0].id;
  assert.equal((await act(a.cookie, { type: 'vote', choiceId: choice })).status, 200);
  await act(a.cookie, { type: 'vote', choiceId: choice });
  assert.equal(f.rooms.owner(room.id).board.choices[0].votes.length, 1);
  await act(b.cookie, { type: 'task', taskId: task, done: true }); assert.equal(f.rooms.owner(room.id).board.tasks[0].done, true);
  const version = room.board.notesVersion;
  assert.equal((await act(a.cookie, { type: 'notes', text: '共同创作的第一行', version })).status, 200);
  assert.equal((await act(b.cookie, { type: 'notes', text: '覆盖', version })).status, 409);
  assert.equal(f.rooms.owner(room.id).board.notes, '共同创作的第一行');
  assert.equal((await act(a.cookie, { type: 'close' })).status, 403);
});
test('removal, expiry and closing invalidate existing cookies and late model output', async t => {
  let finish; const f = await fixture(t, () => new Promise(r => finish = r));
  const room = f.create(), a = await f.enter(room);
  await f.request(`/g-api/${room.id}/actions`, { type: 'message', text: '等待', clientId: crypto.randomUUID() }, a.cookie);
  while (!finish) await new Promise(r => setImmediate(r));
  f.rooms.action(room.id, 'self', { type: 'remove', participantId: a.body.me.id, clientId: crypto.randomUUID() });
  assert.equal((await f.request(`/g-api/${room.id}`, undefined, a.cookie)).status, 401);
  f.rooms.action(room.id, 'self', { type: 'close', clientId: crypto.randomUUID() }); finish('SHOULD_NOT_PUBLISH');
  await settled(f, room.id); assert.ok(!JSON.stringify(f.rooms.owner(room.id)).includes('SHOULD_NOT_PUBLISH'));
  const expiring = f.create(), b = await f.enter(expiring); f.advance(25 * 3600_000);
  assert.equal((await f.request(`/g-api/${expiring.id}`, undefined, b.cookie)).status, 410);
});
test('Agent quota, failed execution and interrupted restart never silently replay work', async t => {
  const f = await fixture(t, async () => { throw new Error('PRIVATE_TOKEN_PATH'); }), room = f.create({ maxTurns: 1 }), a = await f.enter(room);
  await f.request(`/g-api/${room.id}/actions`, { type: 'message', text: '问一句', clientId: crypto.randomUUID() }, a.cookie);
  const state = await settled(f, room.id); assert.equal(state.jobs[0].status, 'failed'); assert.ok(!JSON.stringify(state).includes('PRIVATE_TOKEN_PATH'));
  assert.equal((await f.request(`/g-api/${room.id}/actions`, { type: 'message', text: '再问', clientId: crypto.randomUUID() }, a.cookie)).status, 429);
  f.store.put('play_job', { id: 'interrupted', roomId: room.id, status: 'running', backend: 'pi', actorId: 'self' });
  const recovered = new Playrooms(f.store, {}); assert.equal(recovered.owner(room.id).jobs.find(j => j.id === 'interrupted').status, 'unknown'); await recovered.close();
});
test('guest listener refuses private routes, untrusted origins, invalid fields, oversize messages and forged identities', async t => {
  const f = await fixture(t), room = f.create(), a = await f.enter(room);
  assert.equal((await f.request('/api/bootstrap')).status, 404);
  assert.equal((await f.request('/g-api/preview', { invite: f.rooms.invitation(room.id).token }, null, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request(`/g-api/${room.id}/actions`, { type: 'message', text: 'hello', actorId: 'self', clientId: crypto.randomUUID() }, a.cookie)).status, 400);
  assert.equal((await f.request(`/g-api/${room.id}/actions`, { type: 'message', text: 'x'.repeat(4001), clientId: crypto.randomUUID() }, a.cookie)).status, 400);
});
test('removing an anonymous participant rotates the invitation so the old link cannot issue a new identity', async t => {
  const f = await fixture(t), room = f.create(), token = f.rooms.invitation(room.id).token, a = await f.enter(room);
  f.rooms.action(room.id, 'self', { type: 'remove', participantId: a.body.me.id, clientId: crypto.randomUUID() });
  assert.equal((await f.request('/g-api/preview', { invite: token })).status, 404);
  assert.notEqual(f.rooms.invitation(room.id).token, token);
});
test('a full length Chinese shared note fits the byte limit and persists', async t => {
  const f = await fixture(t), room = f.create(), a = await f.enter(room), value = '共'.repeat(12000);
  const saved = await f.request(`/g-api/${room.id}/actions`, { type: 'notes', version: 1, text: value, clientId: crypto.randomUUID() }, a.cookie);
  assert.equal(saved.status, 200); assert.equal(saved.body.board.notes, value);
});
test('digital twin presents the published host identity instead of the underlying CLI brand', async t => {
  const f = await fixture(t), room = f.create({ template: 'twin', hostName: '小熊' });
  assert.equal(room.agentName, '小熊的分身');
});
test('cancelling a running child stays durably stopping and restart fences it as unknown', async t => {
  let finish; const f = await fixture(t, () => new Promise(r => finish = r)), room = f.create();
  f.rooms.action(room.id, 'self', { type: 'message', text: '等待', clientId: crypto.randomUUID() });
  while (!finish) await new Promise(r => setImmediate(r));
  f.rooms.action(room.id, 'self', { type: 'close', clientId: crypto.randomUUID() });
  try {
    assert.equal(f.store.list('play_job')[0].status, 'stopping');
    const recovered = new Playrooms(f.store, {}); await recovered.close();
    assert.equal(f.store.list('play_job')[0].status, 'unknown');
  } finally { finish('不得公开'); }
});
test('normal and guest executors share the same uncertain-stop barrier', async t => {
  const f = await fixture(t), room = f.create();
  f.store.put('thread', { id: 'normal', runs: [{ localAgentId: 'pi', stopUnconfirmed: true }] });
  assert.throws(() => f.rooms.action(room.id, 'self', { type: 'message', text: '不能绕过', clientId: crypto.randomUUID() }), { code: 'local_agent_stop_unconfirmed' });
  f.store.put('thread', { id: 'normal', runs: [] });
  f.store.put('play_job', { id: 'guest-unknown', backend: 'pi', status: 'unknown' });
  assert.throws(() => f.store.assertExecutorReady('pi'), { code: 'local_agent_stop_unconfirmed' });
});
test('accepted guests have independent polling quotas behind the same tunnel peer', async t => {
  const f = await fixture(t), room = f.create(), a = await f.enter(room), b = await f.enter(room);
  for (let i = 0; i < 305; i++) assert.equal((await f.request(`/g-api/${room.id}`, undefined, a.cookie)).status, 200);
  for (let i = 0; i < 305; i++) assert.equal((await f.request(`/g-api/${room.id}`, undefined, b.cookie)).status, 200);
});
test('an unconfirmed cancellation remains unknown and blocks further use of the same backend', async t => {
  const f = await fixture(t, (_context, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('private stop details'), { code: 'stop_unconfirmed' })))));
  const room = f.create(), a = await f.enter(room);
  await f.request(`/g-api/${room.id}/actions`, { type: 'message', text: '等待停止', clientId: crypto.randomUUID() }, a.cookie);
  while (!f.rooms.owner(room.id).jobs.some(j => j.status === 'running')) await new Promise(r => setImmediate(r));
  f.rooms.action(room.id, 'self', { type: 'close', clientId: crypto.randomUUID() });
  await settled(f, room.id); assert.equal(f.rooms.owner(room.id).jobs[0].status, 'unknown');
  const next = f.create(), b = await f.enter(next);
  assert.equal((await f.request(`/g-api/${next.id}/actions`, { type: 'message', text: '不能绕过核查', clientId: crypto.randomUUID() }, b.cookie)).status, 409);
  const unknown = f.rooms.owner(room.id).jobs[0];
  f.rooms.action(room.id, 'self', { type: 'acknowledge', jobId: unknown.id, confirmedStopped: true, clientId: crypto.randomUUID() });
  assert.equal(f.rooms.owner(room.id).jobs[0].status, 'failed');
});
