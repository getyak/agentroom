import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore } from './store.mjs';
import { Messenger } from './messenger.mjs';
import { ChatTools, CHAT_TOOLS } from './chat-tools.mjs';
import { threadContext } from './runtime.mjs';
import { Decisions } from './decisions.mjs';
import { CreationService } from './creation-service.mjs';

function fixture(t, localAgentId = 'codex') {
  const dir = mkdtempSync(join(tmpdir(), 'agentroom-chat-tools-')), store = new PersonalStore(dir), messenger = new Messenger(store);
  for (const [id, name] of [['planner', '规划师'], ['writer', '编辑'], ['hidden', '未采用']]) store.put('contact', {
    id, name, handle: id, kind: 'agent', added: id !== 'hidden', binding: { type: 'local', localAgentId }, version: 1, instructions: 'PRIVATE_INSTRUCTIONS', profile: null,
  });
  store.put('contact', { id: 'friend', name: '朋友', handle: 'friend', kind: 'human', version: 1 });
  const thread = messenger.createChat({ kind: 'direct', memberIds: ['planner'] });
  thread.messages.push({ id: 'input', role: 'user', text: '帮我建群', contactId: 'self', recipientIds: thread.memberIds, attachments: [] });
  thread.runs.push({ id: 'run', mode: 'codex', localAgentId, contactId: 'planner', contactSnapshot: { id: 'planner', name: '规划师' },
    status: 'running', messageId: 'input', memoryIds: [], artifactReads: [], participantSnapshot: thread.memberIds.map(id => ({ id })), participantMemberships: structuredClone(thread.members) });
  store.put('thread', thread);
  const tools = new ChatTools(store, messenger), context = { threadId: thread.id, runId: 'run' };
  const decisions = new Decisions(store, { chatTools: tools });
  t.after(async () => { await tools.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const call = (name, args = {}, key = `call-${++n}`) => tools.call(context, name, args, key);
  const approve = result => decisions.respond(result.decisionId, { clientId: `approve-${result.decisionId}`, version: 1, choice: 'approve' }, { type: 'owner' });
  return { store, messenger, thread, tools, context, call, approve, decisions };
}

test('directory exposes adopted public identities, not instructions, bindings or credentials', t => {
  const f = fixture(t), result = f.call('list_contacts');
  assert.deepEqual(result.contacts.map(c => c.id).sort(), ['friend', 'planner', 'self', 'writer']);
  assert.equal(result.contacts.find(c => c.id === 'friend').availability, 'local_only');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INSTRUCTIONS|binding|credential/);
  assert.equal(CHAT_TOOLS.length, 9);
});

test('guest and legacy group identities stay out of global discovery and invitations', t => {
  const f = fixture(t);
  for (const flag of ['externalGuest', 'groupLegacy']) f.store.put('contact', { id: flag, handle: flag, name: flag, kind: 'agent', [flag]: true });
  assert.ok(!f.call('list_contacts').contacts.some(c => ['externalGuest', 'groupLegacy'].includes(c.id)));
  for (const contactId of ['externalGuest', 'groupLegacy']) assert.throws(() => f.call('create_room', { name: '不可邀请', memberIds: [contactId] }), e => e.code === 'contact_not_available');
});

test('pending private actions cannot cross a publication or replacement invitation boundary', t => {
  const f = fixture(t), target = f.messenger.createChat({ kind: 'group', title: '目标', memberIds: ['planner', 'writer'] });
  const pending = f.call('send_message', { roomId: target.id, text: '私有资料' });
  f.store.put('play_room', { id: 'published', threadId: target.id, state: 'published', scopeVersion: 1 });
  assert.throws(() => f.approve(pending), e => e.code === 'chat_scope_changed');
  assert.equal(f.store.require('thread', target.id).messages.length, 0);
  assert.throws(() => f.call('send_message', { roomId: target.id, text: '另一个申请' }), e => e.code === 'room_not_visible');
  f.store.put('play_room', { ...f.store.require('play_room', 'published'), closedAt: 'closed' });
  assert.throws(() => f.approve(pending), e => e.code === 'chat_scope_changed');
  const sourcePending = f.call('create_room', { name: '候选群', memberIds: ['writer'] });
  f.store.put('play_room', { id: 'source-public', threadId: f.thread.id, state: 'published', scopeVersion: 1 });
  assert.throws(() => f.approve(sourcePending), e => e.code === 'chat_scope_changed');
});

test('group request is attributed and creates nothing before owner approval; duplicate approval creates one room', t => {
  const f = fixture(t), result = f.call('create_room', { name: '尼泊尔旅行', memberIds: ['writer'], text: '来规划路线' }, 'create-once');
  assert.equal(result.status, 'pending_approval'); assert.equal(f.store.list('thread').length, 1);
  assert.deepEqual(f.call('create_room', { name: '尼泊尔旅行', memberIds: ['writer'], text: '来规划路线' }, 'create-once'), result);
  f.store.updateThread(f.thread.id, thread => { thread.runs[0].status = 'completed'; });
  f.approve(result); f.approve(result);
  const group = f.store.list('thread').find(thread => thread.kind === 'group');
  assert.deepEqual(group.memberIds.sort(), ['self', 'planner', 'writer'].sort());
  assert.equal(group.messages[0].contactId, 'planner'); assert.equal(group.runs.length, 0);
  const decision = f.store.require('thread', f.thread.id).decisions[0];
  assert.equal(decision.result.threadId, group.id); assert.equal(decision.actionState, 'completed');
});

test('rejection has no side effects and callers cannot self-approve', t => {
  const f = fixture(t), result = f.call('create_room', { name: '研究', memberIds: ['writer'] });
  assert.throws(() => f.decisions.respond(result.decisionId, { clientId: 'agent-approval', version: 1, choice: 'approve' }, { type: 'agent' }), e => e.code === 'not_approver');
  f.decisions.respond(result.decisionId, { clientId: 'reject-once', version: 1, choice: 'reject' }, { type: 'owner' });
  assert.equal(f.store.list('thread').length, 1);
});

test('stopped runs, changed bindings, bad schemas and reused call IDs fail closed', t => {
  const f = fixture(t);
  f.call('create_room', { name: '研究', memberIds: ['writer'] }, 'one');
  assert.throws(() => f.call('create_room', { name: '不同群', memberIds: ['writer'] }, 'one'), e => e.code === 'idempotency_conflict');
  assert.throws(() => f.call('create_room', { name: '研究', memberIds: ['hidden'] }), e => e.status === 403);
  assert.throws(() => f.call('list_contacts', { arbitrary: true }), e => e.code === 'invalid_tool_input');
  f.store.updateThread(f.thread.id, thread => { thread.runs[0].status = 'cancelled'; });
  assert.throws(() => f.call('list_contacts'), e => e.status === 403);
});

test('pending actions reject source membership and target identity changes', t => {
  const f = fixture(t), result = f.call('create_room', { name: '研究', memberIds: ['writer'] });
  f.store.put('contact', { ...f.store.require('contact', 'writer'), binding: { type: 'local', localAgentId: 'pi' } });
  assert.throws(() => f.approve(result), e => e.code === 'chat_scope_changed');
  assert.equal(f.store.list('thread').length, 1);
});

test('shared-room reads honor all audience join boundaries and accepted input cutoff', t => {
  const f = fixture(t), target = f.messenger.createChat({ kind: 'group', title: '共同研究', memberIds: ['planner', 'writer'] });
  target.messages = [
    { id: 'old', role: 'user', text: 'OLD_PRIVATE', recipientIds: target.memberIds, attachments: [] },
    { id: 'new', role: 'user', text: '新资料', recipientIds: target.memberIds, attachments: [] },
  ];
  target.members.find(m => m.contactId === 'self').visibleAfterMessageId = 'old'; f.store.put('thread', target);
  const result = f.call('read_messages', { roomId: target.id });
  assert.deepEqual(result.messages.map(m => m.id), ['new']);
  f.store.updateThread(f.thread.id, thread => { thread.messages.push({ id: 'later', role: 'user', text: 'FUTURE_PRIVATE', recipientIds: thread.memberIds }); });
  assert.doesNotMatch(JSON.stringify(f.call('read_messages')), /FUTURE_PRIVATE/);
  f.store.updateThread(target.id, thread => { thread.members.find(m => m.contactId === 'self').membershipId = 'rejoined'; });
  assert.throws(() => f.tools.assertPublishable(f.context), e => e.code === 'chat_scope_changed');
});

test('group audiences cannot discover or read an Agent private room', t => {
  const f = fixture(t), secret = f.messenger.createChat({ kind: 'group', title: 'PRIVATE_ROOM', memberIds: ['planner', 'friend'] });
  f.store.updateThread(f.thread.id, thread => {
    thread.memberIds.push('writer'); thread.members.push({ contactId: 'writer', membershipId: 'writer-member', visibleAfterMessageId: null });
    thread.runs[0].participantMemberships = structuredClone(thread.members); thread.runs[0].participantSnapshot.push({ id: 'writer' }); thread.messages[0].recipientIds.push('writer');
  });
  assert.doesNotMatch(JSON.stringify(f.call('list_rooms')), /PRIVATE_ROOM/);
  assert.throws(() => f.call('read_messages', { roomId: secret.id }), e => e.status === 403);
});

test('Agent messages keep their sender and never wake other Agents; human delivery is not fabricated', t => {
  const f = fixture(t), target = f.messenger.createChat({ kind: 'group', title: '研究', memberIds: ['planner', 'writer'] });
  const sent = f.call('send_message', { roomId: target.id, text: '已完成研究' }); f.approve(sent);
  const saved = f.store.require('thread', target.id);
  assert.equal(saved.messages[0].contactId, 'planner'); assert.equal(saved.messages[0].role, 'assistant'); assert.equal(saved.runs.length, 0);
  assert.throws(() => f.call('send_direct_message', { contactId: 'friend', text: '你好' }), e => e.code === 'human_delivery_unavailable');
  const dm = f.call('send_direct_message', { contactId: 'writer', text: '请看研究' }); f.approve(dm);
  const room = f.store.list('thread').find(thread => thread.agentDirect?.fromContactId === 'planner');
  assert.deepEqual(room.memberIds.sort(), ['self', 'planner', 'writer'].sort()); assert.equal(room.messages[0].contactId, 'planner');
});

test('invites require a current group version and preserve the post-join history boundary', t => {
  const f = fixture(t), target = f.messenger.createChat({ kind: 'group', title: '研究', memberIds: ['planner', 'friend'] });
  target.messages.push({ id: 'private-before', role: 'assistant', text: '加入前', recipientIds: target.memberIds }); f.store.put('thread', target);
  const request = f.call('add_room_member', { roomId: target.id, contactId: 'writer', version: 1 });
  f.approve(request);
  const saved = f.store.require('thread', target.id);
  assert.equal(saved.version, 2); assert.equal(saved.members.find(m => m.contactId === 'writer').visibleAfterMessageId, 'private-before');
});

test('a stale source membership blocks approval; cancelled runs cannot approve old actions', t => {
  const f = fixture(t), request = f.call('create_room', { name: '研究', memberIds: ['writer'] });
  f.store.updateThread(f.thread.id, thread => { thread.members[0].membershipId = 'rejoined'; });
  assert.throws(() => f.approve(request), e => e.code === 'chat_scope_changed');
  assert.equal(f.store.list('thread').length, 1);
  const other = fixture(t), pending = other.call('create_room', { name: '研究', memberIds: ['writer'] });
  other.store.updateThread(other.thread.id, thread => { thread.runs[0].status = 'cancelled'; });
  assert.throws(() => other.approve(pending), e => e.code === 'inactive_decision');
});

test('completed chat action receipts survive recovery while the source model is still running', t => {
  const f = fixture(t), pending = f.call('create_room', { name: '研究', memberIds: ['writer'] }); f.approve(pending);
  f.store.recover();
  const decision = f.store.require('thread', f.thread.id).decisions[0];
  assert.equal(decision.actionState, 'completed'); assert.equal(decision.deliveryState, 'delivered'); assert.equal(decision.verificationState, 'verified');
  assert.equal(f.store.list('thread').filter(t => t.kind === 'group').length, 1);
});

test('artifact scope is frozen and checked before proposing and again before approving chat writes', t => {
  const f = fixture(t); let allowed = false;
  f.tools.options.creation = { readDependenciesAllowed: () => allowed };
  f.store.updateThread(f.thread.id, thread => { thread.runs[0].artifactReads = [{ artifactId: 'private-artifact', revisionId: 'rev-1', paths: ['private.md'] }]; });
  assert.throws(() => f.call('create_room', { name: '研究', memberIds: ['writer'], text: 'PRIVATE_ARTIFACT' }), e => e.code === 'artifact_scope_changed');
  allowed = true;
  const pending = f.call('create_room', { name: '研究', memberIds: ['writer'], text: 'PRIVATE_ARTIFACT' });
  allowed = false;
  assert.throws(() => f.approve(pending), e => e.code === 'artifact_scope_changed');
  assert.equal(f.store.list('thread').length, 1);
});

test('approved exact-text forwarding is readable and propagates its revocable provenance into later replies', t => {
  const f = fixture(t); f.call('read_messages');
  const pending = f.call('send_direct_message', { contactId: 'writer', text: '批准分享的摘要' }); f.approve(pending);
  const target = f.store.list('thread').find(t => t.agentDirect);
  const sent = target.messages[0];
  assert.ok(f.tools.canReadMessage(sent, target.memberIds));
  const forwarded = { ...sent, id: 'derived-reply', chatActionId: undefined };
  assert.ok(f.tools.canReadMessage(forwarded, target.memberIds));
  target.members[0].membershipId = 'rejoined'; f.store.put('thread', target);
  assert.equal(f.tools.canReadMessage(sent, target.memberIds), false);
  assert.equal(f.tools.canReadMessage(forwarded, target.memberIds), false);
});

test('later thread context excludes replies and reactions whose source room membership changed', t => {
  const f = fixture(t), target = f.messenger.createChat({ kind: 'group', title: '来源', memberIds: ['planner', 'friend'] });
  target.messages.push({ id: 'visible-source', role: 'user', text: '资料', recipientIds: target.memberIds }); f.store.put('thread', target);
  f.call('read_messages', { roomId: target.id });
  const dependencies = f.store.require('thread', f.thread.id).runs[0].chatToolReads;
  f.store.updateThread(f.thread.id, thread => {
    thread.runs[0].status = 'completed';
    thread.messages.push({ id: 'derived', role: 'assistant', text: 'DERIVED_PRIVATE', contactId: 'planner', recipientIds: thread.memberIds, chatToolReads: dependencies });
    thread.messages[0].reactions = [{ emoji: '👍', contactId: 'planner', recipientIds: thread.memberIds, chatToolReads: dependencies }];
    thread.messages.push({ id: 'next-input', role: 'user', text: '下一条', recipientIds: thread.memberIds });
    thread.runs.push({ ...thread.runs[0], id: 'next-run', status: 'running', messageId: 'next-input', chatToolReads: [] });
  });
  f.store.updateThread(target.id, thread => { thread.members[0].membershipId = 'rejoined'; });
  const thread = f.store.require('thread', f.thread.id), run = thread.runs.at(-1);
  const context = threadContext(f.store, thread, run, { options: { chatTools: f.tools }, captureContextReads() {} });
  assert.doesNotMatch(JSON.stringify(context), /DERIVED_PRIVATE|👍/);
});

test('only durably prepared, unsent remote continuations are requeued after recovery', t => {
  const f = fixture(t);
  f.store.updateThread(f.thread.id, thread => Object.assign(thread.runs[0], { mode: 'connection', phase: 'prepare', deliveryState: 'not_sent', externalTaskId: null,
    remoteToolRound: 1, remoteToolResults: [{}], remoteRounds: [{}] }));
  f.store.recover(); assert.equal(f.store.require('thread', f.thread.id).runs[0].status, 'queued');
});

test('scheduled runs can publish valid inherited reads but cannot initiate chat tool calls', t => {
  const f = fixture(t); f.call('read_messages');
  f.store.updateThread(f.thread.id, thread => { thread.runs[0].agentSchedule = { mode: 'autonomous' }; });
  assert.doesNotThrow(() => f.tools.assertPublishable(f.context));
  assert.throws(() => f.call('read_messages'), e => e.code === 'inactive_chat_tool');
});

test('chat-source revocation blocks creation cards and already approved work through the shared authorization gate', async t => {
  const f = fixture(t), creation = new CreationService(f.store, { chatTools: f.tools });
  t.after(() => creation.close());
  const target = f.messenger.createChat({ kind: 'group', title: '来源', memberIds: ['planner', 'friend'] });
  target.messages.push({ id: 'visible', role: 'user', text: '资料', recipientIds: target.memberIds }); f.store.put('thread', target);
  f.call('read_messages', { roomId: target.id });
  const dependencies = f.store.require('thread', f.thread.id).runs[0].chatToolReads;
  assert.equal(creation.canPublishConversation(f.thread.id, 'run'), true);
  f.store.put('collaboration', { id: 'work', chatToolReads: dependencies });
  f.store.put('capability_grant', { id: 'grant', workId: 'work', threadId: f.thread.id, audienceIds: f.thread.memberIds });
  f.store.updateThread(target.id, thread => { thread.members[0].membershipId = 'rejoined'; });
  assert.equal(creation.canPublishConversation(f.thread.id, 'run'), false);
  assert.equal(creation.cardAllowed(f.thread.id, 'run', f.thread.memberIds), false);
  assert.throws(() => creation.grant({ grantId: 'grant', contactId: 'planner' }), e => e.code === 'grant_revoked');
});

test('message previews and remote transcripts have explicit text budgets', t => {
  const f = fixture(t), target = f.messenger.createChat({ kind: 'group', title: '长资料', memberIds: ['planner', 'friend'] });
  target.messages = Array.from({ length: 30 }, (_, i) => ({ id: `long-${i}`, role: 'user', text: '长'.repeat(3000), recipientIds: target.memberIds })); f.store.put('thread', target);
  const page = f.call('read_messages', { roomId: target.id, limit: 50 });
  assert.ok(JSON.stringify(page).length < 30000); assert.ok(page.nextBefore); assert.ok(page.messages.some(m => m.truncated));
  const history = Array.from({ length: 8 }, (_, i) => ({ callId: `call-${i}`, result: { text: '长'.repeat(24000) } }));
  const bounded = f.tools.remoteResults(history);
  assert.ok(JSON.stringify(bounded.results).length < 40000); assert.equal(bounded.omitted, 7);
});
