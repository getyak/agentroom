import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore } from './store.mjs';
import { MCPAccess } from './mcp-access.mjs';
import { Decisions } from './decisions.mjs';
import { connectionBinding } from './decisions.mjs';

const catalog = [{ name: 'read_trip', description: 'Read trip notes', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }, { name: 'write_trip', inputSchema: { type: 'object' } }];
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agentroom-mcp-access-'));
  const store = new PersonalStore(dir);
  store.put('contact', { id: 'planner', kind: 'agent', name: '规划师', binding: { type: 'local', localAgentId: 'codex' } });
  store.put('contact', { id: 'writer', kind: 'agent', name: '编辑', binding: { type: 'local', localAgentId: 'claude' } });
  store.put('connection', { id: 'trip', name: 'Trip tools', type: 'mcp', url: 'https://tools.example/mcp', protocolVersion: '2025-11-25', initializedAt: 'test' });
  const members = [{ contactId: 'self', membershipId: 'self-1' }, { contactId: 'planner', membershipId: 'planner-1' }, { contactId: 'writer', membershipId: 'writer-1' }];
  const run = { id: 'parent', mode: 'codex', status: 'running', localAgentId: 'codex', contactId: 'planner', contactSnapshot: { id: 'planner', name: '规划师' },
    messageId: 'message', participantSnapshot: members.map(m => ({ id: m.contactId })), participantMemberships: members,
    conversationSnapshot: { kind: 'group', version: 1 }, memoryIds: [], visibleAfterMessageId: null, artifactReads: [] };
  store.put('thread', { id: 'chat', kind: 'group', title: '旅行群', memberIds: members.map(m => m.contactId), members, messages: [{ id: 'message', role: 'user', text: '查看旅程', attachments: [], recipientIds: members.map(m => m.contactId) }], runs: [run], decisions: [], events: [], artifacts: [], memoryIds: [] });
  let discoveries = 0;
  const access = new MCPAccess(store, { discover: async connection => { discoveries++; return { tools: structuredClone(catalog), binding: connectionBinding(connection) }; }, validateAction: (args, tools) => {
    if (!tools.some(tool => tool.name === args.toolName) || (args.verification && !tools.some(tool => tool.name === args.verification.toolName))) throw new Error('unknown tool');
    return { toolName: args.toolName, arguments: args.arguments, ...(args.verification ? { verification: args.verification } : {}) };
  } });
  t.after(async () => { await access.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const enable = (overrides = {}) => access.save('trip', { version: store.get('mcp_access', 'trip')?.version || 0, enabled: true, contactIds: ['planner'], threadIds: ['chat'], toolNames: ['read_trip'], ...overrides });
  const context = { threadId: 'chat', runId: 'parent' };
  const search = () => access.search(context, { query: 'trip' });
  const request = async (callId = 'one', more = {}) => {
    const result = await access.search(context, { query: 'trip', connectionId: 'trip' }), tool = result.tools[0];
    return access.request(context, { connectionId: 'trip', toolName: 'read_trip', arguments: { id: 'synthetic' }, catalogFingerprint: tool.catalogFingerprint, ...more }, callId);
  };
  return { store, access, enable, context, search, request, discoveries: () => discoveries };
}

test('MCP discovery is disabled by default and filters both agent/chat/tool scopes', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.search()).tools, []); assert.equal(f.discoveries(), 0);
  f.enable();
  const result = await f.search();
  assert.deepEqual(result.tools.map(tool => tool.name), ['read_trip']);
  assert.ok(!JSON.stringify(result).includes('https://'));
  f.store.updateThread('chat', thread => { thread.runs.push({ ...thread.runs[0], id: 'other', contactId: 'writer', localAgentId: 'claude' }); });
  assert.deepEqual((await f.access.search({ threadId: 'chat', runId: 'other' }, {})).tools, []);
  assert.throws(() => f.enable({ version: 0 }), error => error.code === 'version_conflict');
});

test('per-chat agent overrides change only that chat and cannot authorize an unrelated agent', async t => {
  const f = await fixture(t); f.enable();
  f.store.put('thread', { ...f.store.require('thread', 'chat'), id: 'other-chat' });
  f.enable({ threadIds: ['chat', 'other-chat'], threadContactIds: { chat: ['writer'] } });
  assert.equal(f.access.allowed('trip', 'chat', 'planner'), null);
  assert.ok(f.access.allowed('trip', 'chat', 'writer'));
  assert.ok(f.access.allowed('trip', 'other-chat', 'planner'));
  assert.equal(f.access.allowed('trip', 'other-chat', 'writer'), null);
  assert.throws(() => f.enable({ threadContactIds: { chat: ['missing'] } }), error => error.code === 'invalid_mcp_access');
});

test('connection access can always be disabled after configured members leave or change executors', async t => {
  const f = await fixture(t); f.enable({ threadContactIds: { chat: ['planner'] } });
  f.store.updateThread('chat', thread => { thread.memberIds = thread.memberIds.filter(id => id !== 'planner'); thread.members = thread.members.filter(member => member.contactId !== 'planner'); });
  f.store.put('contact', { ...f.store.require('contact', 'planner'), binding: { type: 'connection', connectionId: 'other' } });
  const policy = f.store.require('mcp_access', 'trip');
  const disabled = f.access.save('trip', { version: policy.version, enabled: false, contactIds: policy.contactIds, threadIds: policy.threadIds, threadContactIds: policy.threadContactIds, toolNames: policy.toolNames });
  assert.equal(disabled.enabled, false);
  assert.equal(f.access.allowed('trip', 'chat', 'planner'), null);
});

test('a discovered request creates an attributed approval run only once and preserves accepted audience', async t => {
  const f = await fixture(t); f.enable();
  const receipt = await f.request();
  assert.equal(receipt.state, 'approval_required'); assert.equal(receipt.executed, false);
  const thread = f.store.require('thread', 'chat'), child = thread.runs.find(run => run.id === receipt.runId);
  assert.equal(thread.messages.length, 1); assert.equal(child.contactId, 'planner');
  assert.deepEqual(child.participantMemberships, thread.runs[0].participantMemberships);
  assert.equal(child.mode, 'connection'); assert.equal(child.messageId, 'message');
  assert.equal(f.store.list('decision_attempt').length, 0);
  assert.deepEqual(await f.request(), receipt); assert.equal(f.store.require('thread', 'chat').runs.length, 2);
  await assert.rejects(f.request('one', { arguments: { id: 'changed' } }), error => error.code === 'idempotency_conflict');
  f.store.updateThread('chat', item => { item.runs[0].status = 'completed'; });
  assert.doesNotThrow(() => f.access.assertRequest(f.store.require('thread', 'chat'), child));
});

test('model supplied fingerprints and tool names cannot manufacture discovery authority', async t => {
  const f = await fixture(t); f.enable();
  await assert.rejects(f.access.request(f.context, { connectionId: 'trip', toolName: 'read_trip', arguments: {}, catalogFingerprint: 'invented' }, 'bad'), error => error.code === 'catalog_changed');
  await assert.rejects(f.request('bad2', { toolName: 'write_trip' }), error => ['tool_unavailable', 'catalog_changed'].includes(error.code));
  await assert.rejects(f.request('bad3', { verification: { toolName: 'write_trip', arguments: {} } }), error => error.code === 'tool_unavailable');
});

test('scope, credential, local binding and membership replacement invalidate accepted child requests', async t => {
  for (const mutate of [
    f => f.enable({ enabled: false }),
    f => f.store.put('connection', { ...f.store.require('connection', 'trip'), credentialVersion: 2 }),
    f => f.store.put('contact', { ...f.store.require('contact', 'planner'), binding: { type: 'local', localAgentId: 'pi' } }),
    f => f.store.updateThread('chat', thread => { thread.members[1].membershipId = 'rejoined'; }),
  ]) {
    const f = await fixture(t); f.enable(); const receipt = await f.request(); mutate(f);
    const thread = f.store.require('thread', 'chat');
    assert.throws(() => f.access.assertRequest(thread, thread.runs.find(run => run.id === receipt.runId)), error => error.status === 409 || error.status === 403);
  }
});

test('Decisions accepts scoped local-agent requests and checks revocation again inside dispatch claim', async t => {
  const f = await fixture(t); f.enable(); const receipt = await f.request();
  const decisions = new Decisions(f.store, { assertMCPRequest: (thread, run) => f.access.assertRequest(thread, run) });
  const decision = decisions.request('chat', receipt.runId, { operationType: 'mcp', schemaFingerprint: 'schema', payload: { toolName: 'read_trip', arguments: { id: 'synthetic' } }, title: '读取行程', summary: '合成审批', preview: '{}' });
  decisions.respond(decision.id, { clientId: 'approve-once', version: decision.version, choice: 'approve' }, { type: 'owner' });
  f.enable({ enabled: false });
  assert.throws(() => decisions.executor.claim('chat', receipt.runId, 'schema'), error => error.code === 'mcp_access_changed');
  assert.equal(f.store.list('decision_attempt').length, 0);
});

test('revocation during another discovery prevents both later network reads and stale catalog disclosure', async t => {
  for (const revokeEarlier of [false, true]) {
    const f = await fixture(t); f.enable();
    f.store.put('connection', { ...f.store.require('connection', 'trip'), id: 'second', name: 'Second trip' });
    f.access.save('second', { version: 0, enabled: true, contactIds: ['planner'], threadIds: ['chat'], toolNames: [] });
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; }), reads = [];
    // list() returns newest first: second, then trip.
    f.access.options.discover = async connection => {
      reads.push(connection.id);
      if (connection.id === (revokeEarlier ? 'trip' : 'second')) { entered(); await new Promise(resolve => { release = resolve; }); }
      return { tools: catalog, binding: connectionBinding(connection) };
    };
    const search = f.search();
    await started;
    if (revokeEarlier) f.access.save('second', { version: 1, enabled: false, contactIds: ['planner'], threadIds: ['chat'], toolNames: [] });
    else f.enable({ enabled: false });
    release();
    if (revokeEarlier) await assert.rejects(search, error => error.code === 'mcp_access_changed');
    else { await search; assert.deepEqual(reads, ['second']); }
  }
});

test('a catalog obtained before session rotation cannot be relabeled with the replacement credentials', async t => {
  const f = await fixture(t); f.enable(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.access.options.discover = async connection => { entered(); await new Promise(resolve => { release = resolve; }); return { tools: catalog, binding: connectionBinding(connection) }; };
  const search = f.search(); await started;
  f.store.put('connection', { ...f.store.require('connection', 'trip'), credentialVersion: 2 }); release();
  const result = await search;
  assert.equal(result.tools.length, 0);
  assert.equal(result.unavailable[0].code, 'catalog_identity_changed');
  assert.equal(f.store.list('mcp_catalog').length, 0);
});

test('connection discovery can page beyond twenty services and completed parent catalogs can be released', async t => {
  const f = await fixture(t); f.enable();
  for (let i = 0; i < 20; i++) {
    const id = `additional-${String(i).padStart(2, '0')}`;
    f.store.put('connection', { ...f.store.require('connection', 'trip'), id, name: 'Another service' });
    f.access.save(id, { version: 0, enabled: true, contactIds: ['planner'], threadIds: ['chat'], toolNames: [] });
  }
  const first = await f.access.search(f.context, { query: 'Trip tools' });
  assert.ok(first.nextConnectionCursor); assert.equal(first.truncated, true);
  const second = await f.access.search(f.context, { query: 'Trip tools', connectionCursor: first.nextConnectionCursor });
  assert.equal(second.tools[0].connectionId, 'trip');
  const receipt = await f.request();
  f.access.release('parent'); assert.equal(f.store.list('mcp_catalog').length, 0);
  const thread = f.store.require('thread', 'chat');
  assert.ok(f.access.assertRequest(thread, thread.runs.find(run => run.id === receipt.runId)));
});

test('explicit parent cancellation cancels only unclaimed children', async t => {
  const f = await fixture(t); f.enable();
  const first = await f.request('first'), second = await f.request('second');
  f.store.put('decision_attempt', { id: second.runId, state: 'claimed' });
  f.access.cancelChildren('chat', 'parent');
  const thread = f.store.require('thread', 'chat');
  assert.equal(thread.runs.find(run => run.id === first.runId).status, 'cancelled');
  assert.equal(thread.runs.find(run => run.id === second.runId).status, 'queued');
});
