import { digest } from './store.mjs';
import { groupError as fail, groupFields as fields, groupText as text } from './group-sharing.mjs';
import { validateArtifactInput } from './artifact-tools.mjs';
const string = { type: 'string', maxLength: 12000 };
const definition = (name, description, properties, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const tools = [
  definition('group_artifact_list', 'Read this group’s shared notes and activities, including the current immutable revision. No private Library access.', {}),
  definition('group_artifact_create', 'Create a real group artifact: note (Markdown), poll or quiz (a small shared choice game). Use public material only. No scripts, arbitrary files or network actions.', { kind: { type: 'string', enum: ['note', 'poll', 'quiz'] }, title: string, text: string, choices: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 6 } }, ['kind', 'title']),
  definition('group_artifact_edit', 'Edit only note.md in this group’s shared note. Supply its exact current revisionId and hash. A conflict preserves the old revision; read again before merging.', { artifactId: string, revisionId: string, hash: string, text: string }, ['artifactId', 'revisionId', 'hash', 'text']),
];
/** Fixed-path group capabilities over the existing immutable ArtifactStore. */
export class GroupArtifacts {
  constructor(sharing, creation) { this.sharing = sharing; this.creation = creation; this.store = sharing.store; this.files = creation.artifacts; }
  tools(context) { return context.mode === 'conversation' && this.store.get('thread', context.threadId)?.kind === 'group' ? tools : []; }
  validate(context, name, args) {
    this.sharing.member(context.threadId, context.contactId);
    const tool = this.tools(context).find(t => t.name === name); if (!tool) fail(403, 'tool_unavailable', '当前群没有这个作品工具');
    validateArtifactInput(tool.inputSchema, args);
  }
  call(context, name, args, callId) {
    this.validate(context, name, args);
    if (!this.creation.canPublishConversation(context.threadId, context.runId) || !this.creation.cardAllowed(context.threadId, context.runId, this.store.require('thread', context.threadId).memberIds)) fail(403, 'artifact_scope', '已读资料的授权不再覆盖这个群，未发布群作品');
    const actor = context.contactId, clientId = `agent_${digest(`${context.runId}:${callId}`).slice(0, 40)}`;
    const run = this.store.require('thread', context.threadId).runs.find(run => run.id === context.runId);
    const publicRoom = this.sharing.current(context.threadId);
    const source = { publicShareId: publicRoom?.state === 'published' ? publicRoom.id : null, audienceIds: [...this.store.require('thread', context.threadId).memberIds], artifactReads: structuredClone(run.artifactReads || []), chatToolReads: structuredClone(run.chatToolReads || []) };
    const result = name === 'group_artifact_list' ? { artifacts: this.list(context.threadId, actor) }
      : name === 'group_artifact_create' ? this.create(context.threadId, actor, { ...args, clientId }, source)
      : this.editNote(context.threadId, actor, { ...args, clientId }, source);
    for (const artifact of result.artifacts || [result]) this.creation.recordRead(context, this.readSnapshot(context.threadId, artifact));
    return result;
  }
  sourceId(artifactId, revisionId) { return digest(`${artifactId}:${revisionId}`); }
  combinedSource(previous, current) {
    if (!previous || !current) return previous || current;
    const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
    return { audienceIds: previous.audienceIds.filter(id => current.audienceIds.includes(id)),
      publicShareId: previous.publicShareId === current.publicShareId ? previous.publicShareId : null,
      artifactReads: unique([...(previous.artifactReads || []), ...(current.artifactReads || [])]),
      chatToolReads: unique([...(previous.chatToolReads || []), ...(current.chatToolReads || [])]) };
  }
  readSnapshot(threadId, artifact) {
    const thread = this.store.require('thread', threadId), room = this.sharing.current(threadId);
    return { kind: 'group_artifact', threadId, artifactId: artifact.id, revisionId: artifact.revisionId, shareId: room?.state === 'published' ? room.id : null, scopeVersion: room?.state === 'published' ? room.scopeVersion : null,
      audienceIds: [...thread.memberIds], members: structuredClone(thread.members), bindings: Object.fromEntries(thread.memberIds.map(id => [id, JSON.stringify(this.store.get('contact', id)?.binding || null)])) };
  }
  sourceAllowed(artifactId, revisionId, threadId, audienceIds, depth = 0) {
    const source = this.store.get('group_artifact_source', this.sourceId(artifactId, revisionId));
    const room = this.sharing.current(threadId), publicSource = source?.publicShareId && room?.state === 'published' && room.id === source.publicShareId;
    return !source || ((publicSource || audienceIds.every(id => source.audienceIds.includes(id))) && this.creation.readDependenciesAllowed(threadId, source.artifactReads, audienceIds, depth + 1)
      && (!source.chatToolReads?.length || this.creation.options.chatTools?.canReadMessage({ chatToolReads: source.chatToolReads }, audienceIds)));
  }
  permits(read, audienceIds, depth = 0) {
    const record = this.store.get('group_artifact', read.artifactId), thread = this.store.get('thread', read.threadId), room = this.sharing.current(read.threadId);
    return Boolean(depth <= 20 && record?.threadId === read.threadId && thread && this.store.get('artifact_revision', read.revisionId)?.artifactId === read.artifactId
      && (room?.state === 'published' ? room.id : null) === read.shareId && (room?.state === 'published' ? room.scopeVersion : null) === read.scopeVersion
      && (read.shareId ? audienceIds.every(id => thread.memberIds.includes(id)) : audienceIds.every(id => read.audienceIds.includes(id) && thread.memberIds.includes(id) && read.members.some(member => member.contactId === id && thread.members.some(current => current.contactId === id && current.membershipId === member.membershipId)) && read.bindings[id] === JSON.stringify(this.store.get('contact', id)?.binding || null)))
      && this.sourceAllowed(read.artifactId, read.revisionId, read.threadId, audienceIds, depth));
  }

  operation(threadId, actor, input, operation, effect) {
    this.sharing.member(threadId, actor);
    if (typeof input.clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(input.clientId)) fail(400, 'client_id', '需要稳定的操作标识');
    const id = `group_artifact_${digest(`${threadId}:${actor}:${input.clientId}`).slice(0, 40)}`, hash = digest(JSON.stringify({ operation, input })), previous = this.store.get('group_artifact_operation', id);
    if (previous) {
      if (previous.hash !== hash) fail(409, 'idempotency_conflict', '同一操作标识的内容已变化');
      if (previous.state !== 'completed') fail(409, 'operation_unknown', '上次修改的结果需要核查，没有重复创建');
      if (previous.error) fail(previous.error.status, previous.error.code, previous.error.message);
      return previous.result;
    }
    this.store.put('group_artifact_operation', { id, hash, state: 'pending', threadId, actor });
    try { const result = effect(id); this.store.put('group_artifact_operation', { id, hash, state: 'completed', result, threadId, actor }); const room = this.sharing.current(threadId); if (room) { room.version++; this.store.put('play_room', room); } this.sharing.changed(); return result; }
    catch (error) { this.store.put('group_artifact_operation', { id, hash, state: 'completed', error: { status: error.status || 500, code: error.code || 'artifact_failed', message: error.status ? error.message : '作品修改未完成，请核查' }, threadId, actor }); throw error; }
  }
  scope(threadId, actor, artifactId) {
    this.sharing.member(threadId, actor); const record = this.store.require('group_artifact', artifactId), room = this.sharing.current(threadId);
    if (record.threadId !== threadId || (room?.state === 'published' && record.shareId !== room.id)) fail(403, 'artifact_scope', '这个作品版本没有分享到当前群邀请');
    return record;
  }
  create(threadId, actor, input, source) {
    fields(input, ['kind', 'title', 'text', 'choices', 'clientId']);
    const title = text(input.title, 120);
    if (!['note', 'poll', 'quiz'].includes(input.kind)) fail(400, 'invalid_kind', '请选择便笺、投票或默契游戏');
    const content = input.text ?? ''; if (typeof content !== 'string' || content.length > 12000) fail(400, 'content_limit', '便笺最多 12000 字');
    let choices;
    if (input.kind !== 'note') {
      if (!Array.isArray(input.choices) || input.choices.length < 2 || input.choices.length > 6) fail(400, 'invalid_choices', '小游戏需要 2–6 个选项');
      choices = input.choices.map((label, index) => ({ id: `choice_${index}`, label: text(label, 100) }));
    } else if (input.choices) fail(400, 'invalid_choices', '便笺不接受游戏选项');
    return this.operation(threadId, actor, input, 'create', operationId => {
      if (this.store.list('group_artifact').filter(a => a.threadId === threadId).length >= 12) fail(429, 'artifact_limit', '这个群已有 12 件作品，先一起完善它们吧');
      const context = { owner: true, groupArtifact: true, contactId: actor, runId: operationId };
      const artifact = this.files.create({ title, kind: 'document' }, context);
      const path = input.kind === 'note' ? 'note.md' : 'activity.json', body = input.kind === 'note' ? content : JSON.stringify({ kind: input.kind, title, description: content, choices });
      const stage = this.files.stage(artifact.id, operationId, null, context);
      this.files.write(stage.id, { path, text: body, expectedHash: null }, context);
      const integrated = this.files.integrate(this.files.submit(stage.id, context).id, context);
      const current = this.store.require('workspace_artifact', artifact.id); current.presentation = input.kind; current.groupThreadId = threadId; this.store.put('workspace_artifact', current); this.files.project(current);
      this.store.put('group_artifact', { id: artifact.id, threadId, shareId: this.sharing.current(threadId)?.state === 'published' ? this.sharing.current(threadId).id : null, kind: input.kind, revisionId: integrated.artifact.headRevisionId, createdBy: actor });
      if (source) this.store.put('group_artifact_source', { id: this.sourceId(artifact.id, integrated.artifact.headRevisionId), ...source });
      return this.read(threadId, actor, artifact.id);
    });
  }
  list(threadId, actor) {
    this.sharing.member(threadId, actor); const room = this.sharing.current(threadId);
    return this.store.list('group_artifact').filter(a => a.threadId === threadId && (room?.state !== 'published' || a.shareId === room.id)).map(a => this.read(threadId, actor, a.id));
  }
  read(threadId, actor, artifactId) {
    const record = this.scope(threadId, actor, artifactId), artifact = this.store.require('workspace_artifact', artifactId);
    if (!this.sourceAllowed(artifactId, record.revisionId, threadId, this.store.require('thread', threadId).memberIds)) fail(403, 'artifact_scope', '作品引用资料的共享范围已变化，请主人核查');
    const revision = this.files.revision(artifactId, record.revisionId), path = record.kind === 'note' ? 'note.md' : 'activity.json';
    const read = this.files.read(artifactId, record.revisionId, { owner: true }, [path]);
    const base = { id: artifactId, title: artifact.title, kind: record.kind, revisionId: record.revisionId, hash: revision.files[path].sha256, createdBy: record.createdBy };
    if (record.kind === 'note') return { ...base, text: read.files[0].text };
    const activity = JSON.parse(read.files[0].text), state = this.store.get('group_activity', artifactId)?.votes || {};
    return { ...base, text: activity.description, choices: activity.choices.map(choice => ({ ...choice, votes: Object.entries(state).filter(([, selected]) => selected === choice.id).map(([actor]) => actor) })), myChoice: state[actor] || null };
  }
  editNote(threadId, actor, input, source) {
    fields(input, ['artifactId', 'revisionId', 'hash', 'text', 'clientId']);
    if (typeof input.text !== 'string' || input.text.length > 12000) fail(400, 'content_limit', '便笺最多 12000 字');
    this.scope(threadId, actor, input.artifactId);
    return this.operation(threadId, actor, input, 'edit', operationId => {
      const record = this.scope(threadId, actor, input.artifactId), current = this.read(threadId, actor, record.id);
      if (record.kind !== 'note') fail(400, 'note_required', '这个作品不是可编辑便笺');
      if (current.revisionId !== input.revisionId || current.hash !== input.hash) fail(409, 'notes_conflict', '朋友刚修改了便笺。你的草稿还在，请先看最新内容再合并');
      const provenance = this.combinedSource(this.store.get('group_artifact_source', this.sourceId(record.id, record.revisionId)), source);
      const artifact = this.store.require('workspace_artifact', record.id);
      if (artifact.headRevisionId !== record.revisionId) fail(409, 'unpublished_revision', 'Library 中已有其他修改，请主人先核对，未把它自动公开');
      this.files.ownerChange(record.id, { action: 'edit', expectedVersion: artifact.version, path: 'note.md', text: input.text, expectedHash: input.hash }, { owner: true, contactId: actor, runId: operationId });
      record.revisionId = this.store.require('workspace_artifact', record.id).headRevisionId; this.store.put('group_artifact', record);
      if (provenance) this.store.put('group_artifact_source', { ...provenance, id: this.sourceId(record.id, record.revisionId) });
      return this.read(threadId, actor, record.id);
    });
  }
  act(threadId, actor, input) {
    fields(input, ['artifactId', 'revisionId', 'choiceId', 'clientId']); this.scope(threadId, actor, input.artifactId);
    return this.operation(threadId, actor, input, 'act', () => {
      const activity = this.read(threadId, actor, input.artifactId);
      if (!activity.choices?.some(choice => choice.id === input.choiceId) || activity.revisionId !== input.revisionId) fail(409, 'activity_changed', '游戏选项已变化，请刷新后选择');
      const current = this.store.get('group_activity', activity.id) || { id: activity.id, revisionId: activity.revisionId, votes: {} };
      current.votes[actor] = input.choiceId; this.store.put('group_activity', current); return this.read(threadId, actor, activity.id);
    });
  }
  migrate() {
    for (const room of this.store.list('play_room')) {
      if (!room.threadId || room.groupArtifactsMigrated || room.groupArtifactsMigrationError) continue;
      try {
      {
        const definitions = [];
        if (room.board?.notes) definitions.push({ kind: 'note', title: '共同便笺', text: room.board.notes });
        if (room.board?.tasks?.length) definitions.push({ kind: 'note', title: '一起完成', text: room.board.tasks.map(task => `- [${task.done ? 'x' : ' '}] ${task.label}`).join('\n') });
        if (room.board?.choices?.length >= 2) definitions.push({ kind: 'poll', title: '一起选个方向', choices: room.board.choices.map(c => c.label) });
        definitions.forEach((input, index) => {
          const artifact = this.create(room.threadId, 'self', { ...input, clientId: `migrate_${room.id}_${index}` });
          if (input.kind === 'poll') { const votes = {}; room.board.choices.forEach((choice, i) => { for (const actor of choice.votes || []) votes[actor] = `choice_${i}`; }); this.store.put('group_activity', { id: artifact.id, revisionId: artifact.revisionId, votes }); }
        });
      }
      room.groupArtifactsMigrated = true; this.store.put('play_room', room);
      } catch { this.store.put('play_room', { ...this.store.require('play_room', room.id), groupArtifactsMigrationError: true }); }
    }
  }
}
