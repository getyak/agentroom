import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore } from './store.mjs';
import { Messenger } from './messenger.mjs';
import { CreationService } from './creation-service.mjs';
import { GroupSharing } from './group-sharing.mjs';
import { GroupArtifacts } from './group-artifacts.mjs';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'group-artifacts-')), store = new PersonalStore(dir), messenger = new Messenger(store), creation = new CreationService(store);
  const sharing = new GroupSharing(store, { messenger, creation }), artifacts = new GroupArtifacts(sharing, creation); sharing.artifacts = artifacts;
  t.after(async () => { await sharing.close(); await creation.runtime.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  store.put('contact', { id: 'agent_codex', kind: 'agent', name: '搭子', instructions: 'PRIVATE', binding: { type: 'local', localAgentId: 'codex' }, version: 1 });
  store.put('contact',{id:'group_peer',kind:'human',name:'讨论伙伴',handle:'group-peer',color:'teal',version:1});
  const thread = messenger.createChat({ kind: 'group', title: '一起玩', memberIds: ['agent_codex','group_peer'] });
  const room = sharing.prepare(thread.id, { brief: '公开背景', agents: [{ contactId: 'agent_codex', persona: '公开搭子' }], clientId: crypto.randomUUID() }); sharing.publish(thread.id, { shareId: room.id, version: room.share.version, clientId: crypto.randomUUID() });
  const enter = name => sharing.join({ invite: sharing.invitation(room.id).token, nickname: name, clientId: crypto.randomUUID() }).room.me.id;
  return { store, sharing, artifacts, creation, thread, a: enter('甲'), b: enter('乙') };
}
test('a shared note is a real Library artifact with immutable, attributed CAS revisions', async t => {
  const f = await fixture(t), input = { kind: 'note', title: '旅行小抄', text: '不赶路', clientId: crypto.randomUUID() }, note = f.artifacts.create(f.thread.id, 'self', input);
  assert.equal(f.artifacts.create(f.thread.id, 'self', input).id, note.id); assert.ok(f.store.require('workspace_artifact', note.id));
  const before = f.artifacts.read(f.thread.id, f.a, note.id), updated = f.artifacts.editNote(f.thread.id, f.a, { artifactId: note.id, revisionId: before.revisionId, hash: before.hash, text: '不赶路，预算 800', clientId: crypto.randomUUID() });
  assert.notEqual(updated.revisionId, before.revisionId); assert.equal(f.artifacts.read(f.thread.id, f.b, note.id).text, '不赶路，预算 800');
  const revision = f.creation.artifacts.revision(note.id, updated.revisionId), contribution = f.store.require('artifact_contribution', revision.contributionIds.at(-1)); assert.equal(contribution.contactId, f.a);
  assert.throws(() => f.artifacts.editNote(f.thread.id, f.b, { artifactId: note.id, revisionId: before.revisionId, hash: before.hash, text: '覆盖', clientId: crypto.randomUUID() }), e => e.status === 409);
  assert.equal(f.creation.artifacts.read(note.id, before.revisionId, { owner: true }).files[0].text, '不赶路');
});
test('poll and quiz actions synchronize by real actor, are replay safe and cannot grant arbitrary file access', async t => {
  const f = await fixture(t), poll = f.artifacts.create(f.thread.id, 'self', { kind: 'poll', title: '周末去哪', choices: ['山里', '海边'], clientId: crypto.randomUUID() });
  const action = { artifactId: poll.id, revisionId: poll.revisionId, choiceId: 'choice_1', clientId: crypto.randomUUID() };
  f.artifacts.act(f.thread.id, f.a, action); f.artifacts.act(f.thread.id, f.a, action);
  const current = f.artifacts.read(f.thread.id, f.b, poll.id); assert.equal(current.choices[1].votes.length, 1); assert.equal(current.choices[1].votes[0], f.a);
  assert.throws(() => f.artifacts.act(f.thread.id, f.a, { ...action, clientId: crypto.randomUUID(), actorId: 'self' }), e => e.status === 400);
  const other = f.sharing.messenger.createChat({ kind: 'group', title: '别的群', memberIds: ['agent_codex','group_peer'] }); assert.throws(() => f.artifacts.read(other.id, 'self', poll.id), e => e.status === 403);
  assert.throws(() => f.artifacts.editNote(f.thread.id, f.a, { artifactId: poll.id, revisionId: poll.revisionId, hash: 'x', path: '../../auth.json', text: 'x', clientId: crypto.randomUUID() }), e => e.status === 400);
  f.sharing.action(f.sharing.current(f.thread.id).id, 'self', { type: 'remove', participantId: f.a, clientId: crypto.randomUUID() });
  assert.throws(() => f.artifacts.read(f.thread.id, f.a, poll.id), e => e.status === 403);
});
test('publication cannot promote private in-flight tools or draft-era artifacts into the guest audience', async t => {
  const f = await fixture(t); f.creation.options.groupSharing = f.sharing;
  const group = f.sharing.messenger.createChat({ kind: 'group', title: '原私有群', memberIds: ['agent_codex','group_peer'] });
  const run = f.store.appendRun(group, { text: 'PRIVATE_REQUEST', mode: 'codex', localAgentId: 'codex', contactId: 'agent_codex', contactSnapshot: { instructions: 'PRIVATE_ROLE' } }); run.status = 'running'; f.store.put('thread', group);
  const room = f.sharing.prepare(group.id, { brief: '公开简介', agents: [{ contactId: 'agent_codex', persona: '公开搭子' }], clientId: crypto.randomUUID() });
  const privateNote = f.artifacts.create(group.id, 'self', { kind: 'note', title: '未审核便笺', text: 'PRIVATE_DRAFT_NOTE', clientId: crypto.randomUUID() });
  f.sharing.publish(group.id, { shareId: room.id, version: f.sharing.info(group.id).share.version, clientId: crypto.randomUUID() });
  assert.throws(() => f.creation.context(group.id, run.id), e => e.status === 403); assert.equal(f.creation.canPublishConversation(group.id, run.id), false);
  const guest = f.sharing.join({ invite: f.sharing.invitation(room.id).token, nickname: '新朋友', clientId: crypto.randomUUID() }).room.me.id;
  assert.ok(!f.artifacts.list(group.id, guest).some(a => a.id === privateNote.id));
});
test('one interrupted legacy artifact migration cannot prevent workspace startup or discard the old plan', async t => {
  const f = await fixture(t), room = f.sharing.current(f.thread.id); room.groupArtifactsMigrated = false; room.board = { notes: '保留的旧计划', tasks: [], choices: [] }; f.store.put('play_room', room);
  const create = f.artifacts.create; f.artifacts.create = () => { const error = new Error('pending'); error.code = 'operation_unknown'; throw error; };
  assert.doesNotThrow(() => f.artifacts.migrate()); f.artifacts.create = create;
  assert.equal(f.store.require('play_room', room.id).board.notes, '保留的旧计划'); assert.equal(f.sharing.migrationWarnings(f.thread.id)[0].text, '保留的旧计划'); assert.doesNotThrow(() => f.artifacts.migrate());
});

test('private notes retain project provenance and cannot wash it into a larger audience', async t => {
  const f = await fixture(t); f.creation.options.groupSharing = f.sharing;
  const group = f.sharing.messenger.createChat({ kind: 'group', title: '私有项目', memberIds: ['agent_codex', 'group_peer'] });
  const run = f.store.appendRun(group, { text: '整理便笺', mode: 'codex', contactId: 'agent_codex', participantSnapshot: group.memberIds.map(id => ({ id })) });
  run.status = 'running'; run.artifactReads = [{ kind: 'project', projectId: 'selected' }]; group.messages.at(-1).recipientIds = [...group.memberIds]; f.store.put('thread', group);
  let permitted = true;
  f.creation.options.projects = { permits: (_read, audience) => permitted && audience.every(id => group.memberIds.includes(id)) };
  const context = { threadId: group.id, runId: run.id, contactId: 'agent_codex', mode: 'conversation' };
  const note = f.artifacts.call(context, 'group_artifact_create', { kind: 'note', title: '项目便笺', text: 'SELECTED_PROJECT' }, 'create');
  assert.equal(f.store.require('thread', group.id).runs[0].artifactReads.at(-1).kind, 'group_artifact');
  const read = f.artifacts.readSnapshot(group.id, note);
  assert.ok(f.creation.readDependenciesAllowed(group.id, [read], group.memberIds));
  assert.equal(f.creation.readDependenciesAllowed(group.id, [read], [...group.memberIds, 'outsider']), false);
  const edited = f.artifacts.editNote(group.id, 'self', { artifactId: note.id, revisionId: note.revisionId, hash: note.hash, text: 'SELECTED_PROJECT，补充一句', clientId: crypto.randomUUID() });
  const editedRead = f.artifacts.readSnapshot(group.id, edited);
  assert.equal(f.creation.readDependenciesAllowed(group.id, [editedRead], [...group.memberIds, 'outsider']), false);
  f.store.put('contact', { id: 'outsider', kind: 'human', name: '新成员', version: 1 });
  f.sharing.messenger.updateChat(group.id, { version: group.version, memberIds: [...group.memberIds, 'outsider'] });
  assert.throws(() => f.artifacts.read(group.id, 'self', note.id), e => e.code === 'artifact_scope');
  permitted = false;
  assert.equal(f.creation.readDependenciesAllowed(group.id, [read], group.memberIds), false);
  assert.throws(() => f.artifacts.read(group.id, 'self', note.id), e => e.code === 'artifact_scope');
});

test('a private run cannot publish a note after another member joins', async t => {
  const f = await fixture(t); f.creation.options.groupSharing = f.sharing;
  const group = f.sharing.messenger.createChat({ kind: 'group', title: '私有群', memberIds: ['agent_codex', 'group_peer'] });
  const run = f.store.appendRun(group, { text: '整理', mode: 'codex', contactId: 'agent_codex', participantSnapshot: group.memberIds.map(id => ({ id })) });
  run.status = 'running'; group.messages.at(-1).recipientIds = [...group.memberIds]; f.store.put('thread', group);
  f.store.put('contact', { id: 'late', kind: 'human', name: '后来者', version: 1 });
  f.sharing.messenger.updateChat(group.id, { version: group.version, memberIds: [...group.memberIds, 'late'] });
  assert.throws(() => f.artifacts.call({ threadId: group.id, runId: run.id, contactId: 'agent_codex', mode: 'conversation' }, 'group_artifact_create', { kind: 'note', title: '不能扩大范围', text: 'EARLIER_CONTEXT' }, 'late'), e => e.code === 'artifact_scope');
  assert.equal(f.artifacts.list(group.id, 'self').length, 0);
});
