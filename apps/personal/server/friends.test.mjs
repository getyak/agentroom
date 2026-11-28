import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { openFriendsService } from './friends-service.mjs';
import { FriendsClient } from './friends-client.mjs';
import { PersonalStore } from './store.mjs';

test('friends use exact public codes, explicit acceptance and private, idempotent messages', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agentroom-friends-'));
  const service = await openFriendsService({ dataDir: join(dir, 'service') });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const client = async (name) => {
    const bearer = randomBytes(32).toString('base64url');
    const call = (action, body = {}) => send(service.origin, action, body, { Authorization: `Bearer ${bearer}` });
    const key = randomUUID();
    const { value } = await call('register', { name, clientId: key });
    assert.deepEqual(await call('register', { name, clientId: key }), { status: 200, value });
    return { call, code: value.profile.code };
  };
  const [alice, bob, other] = await Promise.all(['Alice', 'Bob', 'Other'].map(client));
  assert.equal((await alice.call('lookup', { code: bob.code })).value.person.name, 'Bob');
  assert.equal((await alice.call('lookup', { code: 'Alice' })).status, 400);
  assert.equal((await alice.call('request', { code: alice.code, version: 0 })).status, 400);

  const { value: { relationship } } = await alice.call('request', { code: bob.code, version: 0 });
  assert.equal(relationship.state, 'pending');
  assert.equal((await bob.call('request', { code: alice.code, version: 0 })).value.relationship.state, 'pending');
  assert.equal((await alice.call('respond', { code: bob.code, version: relationship.version, decision: 'accept' })).status, 403);
  assert.equal((await bob.call('respond', { code: alice.code, version: relationship.version, decision: ['accept'] })).status, 400);
  assert.equal((await other.call('messages', { code: bob.code })).status, 403);
  assert.equal((await bob.call('send', { code: alice.code, text: 'Too early', clientId: randomUUID() })).status, 403);

  const response = { code: alice.code, version: relationship.version, decision: 'accept' };
  const accepted = await bob.call('respond', response);
  assert.equal(accepted.value.relationship.state, 'accepted');
  assert.deepEqual(await bob.call('respond', response), accepted);
  assert.equal((await alice.call('respond', { code: bob.code, version: relationship.version, decision: 'withdraw' })).status, 409);
  const payload = { code: bob.code, text: 'Hello Bob', clientId: randomUUID() };
  const receipt = await alice.call('send', payload);
  assert.equal(receipt.status, 200);
  assert.deepEqual(await alice.call('send', payload), receipt);
  assert.equal((await alice.call('send', { ...payload, text: 'different' })).status, 409);
  assert.deepEqual((await bob.call('messages', { code: alice.code })).value.messages, [receipt.value.message]);
  assert.equal((await bob.call('respond', { code: alice.code, version: accepted.value.relationship.version, decision: 'remove' })).value.relationship.state, 'removed');
  assert.equal((await alice.call('messages', { code: bob.code })).status, 403);
});

test('invite link enrolls a new browser friend, survives reload and can be revoked', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agentroom-friends-invite-'));
  let clock = Date.now();
  const service = await openFriendsService({ dataDir: join(dir, 'service'), clock: () => clock });
  const store = new PersonalStore(join(dir, 'desktop'));
  t.after(async () => { store.close(); await service.close(); await rm(dir, { recursive: true, force: true }); });
  const desktop = new FriendsClient(store, { origin: service.origin });
  assert.equal((await desktop.state()).profile, null);
  const state = await desktop.act({ action: 'register', name: 'Host', clientId: randomUUID() });
  assert.equal(state.profile.name, 'Host');
  assert.ok(!JSON.stringify(state).includes('credential'));
  const inviteRequest = { action: 'invite', clientId: randomUUID() };
  const { link } = await desktop.act(inviteRequest);
  assert.equal((await desktop.act(inviteRequest)).link.url, link.url);
  const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get('invite');
  const browser = { Origin: service.origin };
  assert.equal((await send(service.origin, 'preview', { token }, browser)).value.person.name, 'Host');
  assert.equal((await send(service.origin, 'register', { name: 'Visitor', clientId: randomUUID() }, { Origin: 'https://other.example' })).status, 403);
  const fixedToken = randomBytes(32).toString('base64url');
  const signup = await raw(service.origin, 'register', { name: 'Visitor', clientId: randomUUID() },
    { ...browser, Cookie: `agentroom_friends=${fixedToken}` });
  assert.equal(signup.status, 200);
  const cookie = signup.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.ok(!cookie.includes(fixedToken));
  const visitor = { ...browser, Cookie: cookie.split(';')[0] };
  const { value } = await send(service.origin, 'join', { token, version: 0 }, visitor);
  assert.equal(value.relationship.source, 'invite');
  assert.equal(value.relationship.state, 'pending');
  assert.equal((await desktop.state()).relationships[0].person.name, 'Visitor');
  assert.equal((await (await fetch(`${service.origin}/api/friends`, { headers: visitor })).json()).relationships.length, 1);
  const second = await raw(service.origin, 'register', { name: 'Second visitor', clientId: randomUUID() }, browser);
  const secondVisitor = { ...browser, Cookie: second.headers.get('set-cookie').split(';')[0] };
  assert.equal((await send(service.origin, 'join', { token, version: 0 }, secondVisitor)).status, 200);
  assert.equal((await desktop.state()).invitation.claims, 2);
  const { link: rotated } = await desktop.act({ action: 'invite', clientId: randomUUID() });
  const newToken = new URLSearchParams(new URL(rotated.url).hash.slice(1)).get('invite');
  assert.equal((await send(service.origin, 'preview', { token }, browser)).status, 404);
  await assert.rejects(() => desktop.act(inviteRequest), { status: 409 });
  await assert.rejects(() => desktop.act({ action: 'revoke', inviteId: link.id }), { status: 409 });
  assert.equal((await send(service.origin, 'join', { token: newToken, version: 0 }, visitor)).status, 200);
  clock += 8 * 86400_000;
  assert.equal((await send(service.origin, 'preview', { token: newToken }, browser)).status, 404);
  await desktop.act({ action: 'revoke', inviteId: rotated.id });
  assert.equal((await desktop.state()).invitation, null);
  assert.equal((await desktop.state()).relationships.length, 2);
});

function raw(origin, action, body, headers) {
  return fetch(`${origin}/api/friends`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ action, ...body }),
  });
}
async function send(...args) {
  const response = await raw(...args);
  return { status: response.status, value: await response.json() };
}
