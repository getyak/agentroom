import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openFriendsService } from './friends-service.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'friends-live-'));
  const server = await openFriendsService({ dataDir: dir });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  return async name => {
    const headers = { Authorization: `Bearer ${randomBytes(32).toString('base64url')}`, 'Content-Type': 'application/json' };
    const call = async (action, body = {}) => {
      const response = await fetch(server.origin + '/api/friends', {
        ...(action && { method: 'POST', body: JSON.stringify({ action, ...body }) }), headers, signal: AbortSignal.timeout(13000),
      });
      return { status: response.status, value: await response.json() };
    };
    const registration = await call('register', { name, clientId: randomUUID() });
    assert.equal(registration.status, 200);
    return { code: registration.value.profile.code, call };
  };
}

async function makeFriends(first, second) {
  const { value: { relationship } } = await first.call('request', { code: second.code, version: 0 });
  assert.equal((await second.call('respond', { code: first.code, version: relationship.version, decision: 'accept' })).status, 200);
}

test('the server wakes only relevant revision subscribers on an accepted message', async t => {
  const client = await fixture(t);
  const [alice, bob, outside] = await Promise.all(['Alice', 'Bob', 'Outside'].map(client));
  await makeFriends(alice, bob);
  const current = (await bob.call()).value.revision;
  assert.ok(Number.isInteger(current));
  const waiting = bob.call('watch', { revision: current });
  const sent = await alice.call('send', { code: bob.code, text: '立即送到', clientId: randomUUID() });
  assert.equal(sent.status, 200);
  const result = await waiting;
  assert.equal(result.status, 200);
  assert.ok(result.value.revision > current);
  assert.equal((await outside.call()).value.revision, 0);
  assert.deepEqual((await bob.call('messages', { code: alice.code })).value.messages, [sent.value.message]);
});

test('friends join a shared room and only the authorizing desktop can complete each Agent request', async t => {
  const client = await fixture(t);
  const [alice, bob, outside] = await Promise.all(['Mac mini', 'MacBook', 'Outside'].map(client));
  await makeFriends(alice, bob);
  const create = { title: '两台 Mac', people: [bob.code], clientId: randomUUID() };
  const created = await alice.call('group-create', create);
  assert.equal(created.status, 200);
  const { room } = created.value;
  const groupId = room.id;
  assert.deepEqual(await alice.call('group-create', create), created);
  assert.equal((await outside.call('group-view', { groupId })).status, 403);
  assert.equal((await bob.call('group-view', { groupId })).status, 403);
  assert.equal((await bob.call()).value.rooms[0].membership, 'invited');

  await alice.call('group-send', { groupId, text: '가입 전', clientId: randomUUID() });
  assert.equal((await bob.call('group-answer', { groupId, decision: 'join' })).status, 200);
  assert.deepEqual((await bob.call('group-view', { groupId })).value.messages, []);

  const agentA = randomUUID(), agentB = randomUUID();
  assert.equal((await alice.call('group-agent-add', { groupId, agentId: agentA, name: 'Mini Codex' })).status, 200);
  assert.equal((await bob.call('group-agent-add', { groupId, agentId: agentB, name: 'Book Codex' })).status, 200);
  assert.equal((await bob.call('group-agent-remove', { groupId, agentId: agentA })).status, 403);
  assert.equal((await alice.call('group-view', { groupId })).value.agents.length, 2);

  const payload = { groupId, text: '请回答 mini 问候', targetAgentId: agentB, clientId: randomUUID() };
  const sent = await alice.call('group-send', payload);
  assert.equal(sent.status, 200);
  assert.deepEqual(await alice.call('group-send', payload), sent);
  assert.equal((await alice.call('group-work')).value.jobs.length, 0);
  const jobs = (await bob.call('group-work')).value.jobs;
  assert.equal(jobs.length, 1);
  const jobId = jobs[0].id;
  const claim = randomBytes(32).toString('base64url');
  assert.equal((await alice.call('group-claim', { jobId, claim })).status, 403);
  const claimed = await bob.call('group-claim', { jobId, claim });
  assert.equal(claimed.status, 200);
  assert.ok(claimed.value.context.messages.some(message => message.text === payload.text));
  assert.ok(!claimed.value.context.messages.some(message => message.text === '가입 전'));
  assert.equal((await bob.call('group-claim', { jobId, claim: randomBytes(32).toString('base64url') })).status, 409);
  const completion = { jobId, claim, text: 'MacBook Codex 收到', failed: false };
  const received = await bob.call('group-finish', completion);
  assert.equal(received.status, 200);
  assert.deepEqual(await bob.call('group-finish', completion), received);
  const messages = (await alice.call('group-view', { groupId })).value.messages;
  assert.equal(messages.at(-1).agentId, agentB);
  assert.equal(messages.at(-1).from, bob.code);
  assert.equal(messages.at(-1).text, completion.text);
  assert.equal(messages.find(message => message.id === sent.value.message.id).jobState, 'finished');

  const sentBack = await bob.call('group-send', { groupId, targetAgentId: agentA, text: '回复 MacBook', clientId: randomUUID() });
  assert.equal(sentBack.status, 200);
  const backId = (await alice.call('group-work')).value.jobs[0].id;
  assert.equal((await alice.call('group-claim', { jobId: backId, claim })).status, 200);
  assert.equal((await alice.call('group-agent-remove', { groupId, agentId: agentA })).status, 200);
  assert.equal((await alice.call('group-finish', { jobId: backId, claim, text: '已经撤销', failed: false })).status, 409);
});

test('Agent context and delayed replies never reveal hidden history to a new member', async t => {
  const client = await fixture(t);
  const [host, late, newest] = await Promise.all(['Host', 'Late', 'Newest'].map(client));
  await makeFriends(host, late);
  await makeFriends(host, newest);
  const { value: { room } } = await host.call('group-create', { title: 'Private history', people: [late.code, newest.code], clientId: randomUUID() });
  const groupId = room.id, targetAgentId = randomUUID(), claim = randomBytes(32).toString('base64url');
  await host.call('group-agent-add', { groupId, agentId: targetAgentId, name: 'Host Codex' });
  await host.call('group-send', { groupId, text: 'Earlier context', clientId: randomUUID(), targetAgentId });
  const oldJob = (await host.call('group-work')).value.jobs[0];
  assert.equal((await host.call('group-claim', { jobId: oldJob.id, claim })).status, 200);
  assert.equal((await late.call('group-answer', { groupId, decision: 'join' })).status, 200);
  assert.equal((await host.call('group-finish', { jobId: oldJob.id, claim, text: 'Quotes earlier context', failed: false })).status, 200);
  assert.deepEqual((await late.call('group-view', { groupId })).value.messages, []);
  await late.call('group-send', { groupId, text: 'Visible request', clientId: randomUUID(), targetAgentId });
  const freshJob = (await host.call('group-work')).value.jobs[0];
  const fresh = await host.call('group-claim', { jobId: freshJob.id, claim });
  assert.deepEqual(fresh.value.context.messages.map(message => message.text), ['Visible request']);
  assert.equal((await newest.call('group-answer', { groupId, decision: 'join' })).status, 200);
  assert.equal((await host.call('group-finish', { jobId: freshJob.id, claim, text: 'Answers visible request', failed: false })).status, 200);
  assert.deepEqual((await newest.call('group-view', { groupId })).value.messages, []);
  assert.equal((await late.call('group-view', { groupId })).value.messages.at(-1)?.text, 'Answers visible request');
});
