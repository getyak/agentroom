import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore } from './store.mjs';
import { Messenger } from './messenger.mjs';
import { GroupSharing } from './group-sharing.mjs';
import { ChatTools } from './chat-tools.mjs';
import { Decisions } from './decisions.mjs';
import { GroupTools } from './group-tools.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'group-tools-')), store = new PersonalStore(dir), messenger = new Messenger(store);
  t.after(async () => { await sharing.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  store.put('contact', { id: 'agent_codex', kind: 'agent', name: '搭子', handle: 'buddy', instructions: 'PRIVATE', discovered: true, added: true, binding: { type: 'local', localAgentId: 'codex' }, availability: 'ready', version: 1 });
  store.put('contact', { ...store.require('contact','agent_codex'), id:'guide', name:'向导', handle:'guide', discovered:false });
  const thread = messenger.createChat({ kind: 'direct', memberIds: ['agent_codex'] });
  const run = store.appendRun(thread, { text: '帮我开旅行群并邀请朋友', mode: 'codex', contactId: 'agent_codex', localAgentId: 'codex', contactSnapshot: { name: '搭子' }, participantSnapshot: [{ id: 'self' }, { id: 'agent_codex' }] });
  thread.messages[0].contactId = 'self'; run.status = 'running'; run.participantMemberships = structuredClone(thread.members); store.put('thread', thread);
  const context = { threadId: thread.id, runId: run.id, messageId: run.messageId, contactId: 'agent_codex', mode: 'conversation' };
  const chatTools = new ChatTools(store, messenger), decisions = new Decisions(store, { chatTools });
  t.after(()=>chatTools.close());
  const sharing = new GroupSharing(store, { messenger, chatTools, validateInput: body => ({ ...body, attachments: [] }) }), tools = new GroupTools(sharing);
  const approve = receipt => { decisions.respond(receipt.decisionId, { clientId: crypto.randomUUID(), version: 1, choice: 'approve' }, { type: 'owner' }); return store.require('thread', thread.id).decisions.find(d=>d.id===receipt.decisionId).result; };
  const create = (args, callId='create') => { const before=store.list('thread').length, receipt=tools.call(context,'group_create',args,callId); assert.equal(receipt.status,'pending_approval'); assert.equal(store.list('thread').length,before); return approve(receipt); };
  return { store, messenger, thread, run, context, sharing, tools, approve, create };

}
test('an owner-requested agent creates a normal group and a concrete invite card without a model bearer', async t => {
  const f = await fixture(t), catalog = f.tools.call(f.context, 'group_contacts', {}, 'list');
  assert.ok(catalog.contacts.some(c => c.id === 'agent_codex')); assert.ok(!JSON.stringify(catalog).includes('PRIVATE'));
  const args = { title: '海风计划', purpose: '共同准备一次周末旅行', agentIds: ['agent_codex', 'guide'] };
  const result = f.create(args, 'create');
  assert.equal(f.store.require('thread', result.threadId).kind, 'group');
  assert.equal(f.tools.call(f.context, 'group_create', args, 'create').status, 'pending_approval');
  const info = f.tools.call(f.context, 'group_info', { threadId: result.threadId }, 'info');
  const invitation = f.tools.call(f.context, 'group_invite', { threadId: result.threadId, version: info.version, brief: '公开的旅行需求', agents: [{ contactId: 'agent_codex', persona: '耐心的旅行搭子' }] }, 'invite');
  assert.equal(invitation.state, 'draft'); assert.ok(!JSON.stringify(invitation).includes('token')); assert.ok(!JSON.stringify(invitation).includes('#'));
  assert.ok(f.store.require('thread', f.thread.id).messages.some(m => m.groupCard?.threadId === result.threadId));
});
test('fresh roster/status invalidates a stale mutation, and public agents cannot inspect the private directory or expand groups', async t => {
  const f = await fixture(t), created = f.create( { title: '一起做', purpose: '一个小项目', agentIds: ['agent_codex', 'guide'] }, 'create');
  const before = f.tools.call(f.context, 'group_info', { threadId: created.threadId }, 'info');
  const group = f.store.require('thread', created.threadId); f.messenger.updateChat(group.id, { version: group.version, title: '新的名字' });
  const after = f.tools.call(f.context, 'group_info', { threadId: group.id }, 'info'); assert.notEqual(after.version, before.version);
  assert.throws(() => f.tools.call(f.context, 'group_add_agents', { threadId: group.id, version: before.version, agentIds: ['agent_codex', 'guide'] }, 'stale'), e => e.code === 'group_changed');
  const runThread = f.store.require('thread', f.thread.id); runThread.runs[0].sharedGroup = { id: 'public' }; f.store.put('thread', runThread);
  assert.throws(() => f.tools.call(f.context, 'group_contacts', {}, 'no'), e => e.status === 403);
  assert.throws(() => f.tools.call(f.context, 'group_create', { title: '泄漏', purpose: 'x', agentIds: ['agent_codex', 'guide'] }, 'no2'), e => e.status === 403);
});
test('standing rules constrain requests and legacy automatic publication becomes owner review', async t => {
  const f = await fixture(t), rules = f.tools.rules();
  assert.throws(() => f.tools.saveRules({ ...rules, version: 99 }), e => e.status === 409);
  f.tools.saveRules({ ...rules, createGroups: false });
  assert.throws(() => f.tools.call(f.context, 'group_create', { title: '不能开', purpose: 'x', agentIds: ['agent_codex', 'guide'] }, 'create'), e => e.code === 'rule_denied');
  assert.throws(()=>f.tools.saveRules({ ...f.tools.rules(), createGroups:true, externalInvites:'auto_new_group' }),e=>e.status===400);
  f.store.put('setting',{ ...f.tools.rules(),createGroups:true,externalInvites:'auto_new_group',maxGroupsPerRequest:1 });assert.equal(f.tools.rules().externalInvites,'review');
  const result = f.create( { title: '开放共创', purpose: 'x', agentIds: ['agent_codex', 'guide'] }, 'create2');
  const info = f.tools.call(f.context, 'group_info', { threadId: result.threadId }, 'info');
  assert.equal(f.tools.call(f.context, 'group_invite', { threadId: result.threadId, version: info.version, brief: '明确公开背景', agents: [{ contactId: 'agent_codex', persona: '公开角色' }] }, 'invite').state, 'draft');
  assert.throws(() => f.tools.call(f.context, 'group_create', { title: '太多了', purpose: 'x', agentIds: ['agent_codex', 'guide'] }, 'exceed'), e => e.code === 'group_budget');
});
test('the organizing agent can prepare an invitation for its own newly created group of other specialists', async t => {
  const f = await fixture(t); f.store.put('contact', { ...f.store.require('contact', 'agent_codex'), id: 'specialist', name: '路线专家', handle: 'specialist', discovered: false });
  const result = f.create( { title: '交给专家', purpose: '旅行', agentIds: ['specialist', 'guide'] }, 'create');
  const info = f.tools.call(f.context, 'group_info', { threadId: result.threadId }, 'info');
  assert.ok(info.roster.some(c => c.id === 'specialist'));
});
test('public group_info uses only the reviewed purpose; rejected creation has no orphan group', async t => {
  const f = await fixture(t), before = f.store.list('thread').length;
  assert.throws(() => f.tools.call(f.context, 'group_create', { title: '无效', purpose: '  ', agentIds: ['agent_codex', 'guide'] }, 'invalid'), e => e.status === 400);
  assert.equal(f.store.list('thread').length, before);
  const created = f.create( { title: '只公开简介', purpose: 'PRIVATE_PURPOSE', agentIds: ['agent_codex', 'guide'] }, 'create');
  const share = f.sharing.prepare(created.threadId, { brief: 'PUBLIC_BRIEF', agents: [{ contactId: 'agent_codex', persona: '公共角色' }], clientId: crypto.randomUUID() }); f.sharing.publish(created.threadId, { shareId: share.id, clientId: crypto.randomUUID(), version: share.share.version });
  const thread = f.store.require('thread', created.threadId), run = f.store.appendRun(thread, { text: '公开问题', contactId: 'agent_codex', mode: 'codex', sharedGroup: { id: share.id } }); run.status = 'running'; run.participantMemberships = structuredClone(thread.members); f.store.put('thread', thread);
  const info = f.tools.call({ threadId: thread.id, runId: run.id, contactId: 'agent_codex' }, 'group_info', {}, 'info'); assert.equal(info.purpose, 'PUBLIC_BRIEF'); assert.ok(!JSON.stringify(info).includes('PRIVATE_PURPOSE'));
});
test('replayed membership changes cannot return a roster after the organizing member was removed', async t => {
  const f = await fixture(t), created = f.create( { title: '撤销测试', purpose: '共同完成', agentIds: ['agent_codex', 'guide'] }, 'create');
  f.store.put('contact', { ...f.store.require('contact', 'agent_codex'), id: 'other', name: '其他搭子', handle: 'other' });
  const version = f.tools.call(f.context, 'group_info', { threadId: created.threadId }, 'info').version, args = { threadId: created.threadId, version, agentIds: ['other'] };
  const requests=f.tools.call(f.context, 'group_add_agents', args, 'add'); requests.requests.forEach(f.approve); const target = f.store.require('thread', created.threadId); f.messenger.updateChat(target.id, { version: target.version, memberIds: ['other'] });
  assert.throws(() => f.tools.call(f.context, 'group_add_agents', args, 'add'), e => e.status === 403);
});
test('an invitation replay describes its original grant rather than a replacement draft', async t => {
  const f = await fixture(t), created = f.create( { title: '原邀请', purpose: '共同完成', agentIds: ['agent_codex', 'guide'] }, 'create');
  const version = f.tools.call(f.context, 'group_info', { threadId: created.threadId }, 'info').version, args = { threadId: created.threadId, version, brief: '第一份背景', agents: [{ contactId: 'agent_codex', persona: '公开角色' }] };
  const original = f.tools.call(f.context, 'group_invite', args, 'invite'); f.sharing.action(original.shareId, 'self', { type: 'close', clientId: crypto.randomUUID() });
  f.sharing.prepare(created.threadId, { clientId: crypto.randomUUID(), brief: '另一份背景', agents: args.agents });
  const replay = f.tools.call(f.context, 'group_invite', args, 'invite'); assert.equal(replay.shareId, original.shareId); assert.equal(replay.state, 'closed'); assert.equal(replay.requiresOwnerReview, false);
});

test('group_create cannot turn an owner and one agent into a group', async t => {
  const f=await fixture(t), before=f.store.list('thread').length;
  assert.throws(()=>f.tools.call(f.context,'group_create',{title:'两位',purpose:'只需私聊',agentIds:['agent_codex']},'pair-create'),e=>e.status===400);
  assert.equal(f.store.list('thread').length,before);
});

test('group_info cannot reveal another private roster to an unshared audience', async t => {
  const f = await fixture(t);
  f.store.put('contact', { ...f.store.require('contact', 'agent_codex'), id: 'secret', name: '私有伙伴', handle: 'secret' });
  const secret = f.messenger.createChat({ kind: 'group', title: '私人话题', memberIds: ['agent_codex', 'secret'] });
  f.store.updateThread(f.thread.id, thread => {
    thread.memberIds.push('guide'); thread.members.push({ contactId: 'guide', membershipId: 'guide-epoch', visibleAfterMessageId: null });
    thread.runs[0].participantMemberships = structuredClone(thread.members); thread.runs[0].participantSnapshot.push({ id: 'guide' });
    thread.messages[0].recipientIds = [...thread.memberIds];
  });
  assert.throws(() => f.tools.call(f.context, 'group_info', { threadId: secret.id }, 'private-roster'), e => e.code === 'room_not_visible');
});
