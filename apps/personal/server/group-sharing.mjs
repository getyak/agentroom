import { randomBytes } from 'node:crypto';
import { Playrooms } from './playrooms.mjs';
import { addReaction, REACTIONS } from './im-participation.mjs';
import { APIError, digest, id, now } from './store.mjs';

export const groupError = (status, code, message) => { throw new APIError(status, code, message); };
export const groupFields = (body, allowed) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) groupError(400, 'invalid_input', '操作包含不支持的内容');
};
export const groupText = (value, max, fallback) => {
  const text = value ?? fallback;
  if (typeof text !== 'string' || !text.trim() || text.length > max) groupError(400, 'invalid_input', `请填写 ${max} 字以内的内容`);
  return text.trim();
};
const integer = (value, fallback, max) => { const number = value ?? fallback; if (!Number.isInteger(number) || number < 1 || number > max) groupError(400, 'invalid_input', '人数、期限或次数超出范围'); return number; };
const terminal = run => ['completed', 'failed', 'cancelled'].includes(run.status);
const person = contact => ({ id: contact.id, kind: contact.kind, name: contact.name, handle: contact.handle, color: contact.color, icon: contact.icon, avatar: contact.avatar, version: contact.version });

/** An invitation grants access to a normal Messenger thread. It owns no conversation or executor. */
export class GroupSharing extends Playrooms {
  constructor(store, options = {}) {
    super(store, { ...options, execute: undefined });
    this.messenger = options.messenger; this.creation = options.creation;
    this.messenger.options.groupSharing = this;
    this.migrate();
  }
  active(room) { super.active(room); if (room.state !== 'published') groupError(403, 'publication_pending', '主人还在确认共同背景，暂时不能加入'); }
  current(threadId) { return this.store.list('play_room').find(room => room.threadId === threadId && !room.closedAt && Date.parse(room.expiresAt) > this.clock()); }
  retireExpired(thread) {
    if (thread.kind !== 'group') return;
    const current = this.current(thread.id), allowed = new Set(current?.state === 'published' ? current.participants.filter(p => !p.removedAt).map(p => p.id) : []);
    const retired = thread.memberIds.filter(actor => this.store.get('contact', actor)?.externalGuest && !allowed.has(actor));
    if (!retired.length) return;
    thread.memberIds = thread.memberIds.filter(actor => !retired.includes(actor)); thread.members = thread.members.filter(m => !retired.includes(m.contactId)); thread.version++; this.store.put('thread', thread);
    for (const room of this.store.list('play_room').filter(r => r.threadId === thread.id)) {
      let changed = false; for (const participant of room.participants) if (retired.includes(participant.id) && !participant.removedAt) { participant.removedAt = this.stamp(); changed = true; }
      if (changed) { room.version++; room.scopeVersion++; if (Date.parse(room.expiresAt) <= this.clock()) room.closedAt ||= this.stamp(); this.store.put('play_room', room); }
    }
    queueMicrotask(() => { if (!this.closed) this.cancelPublic(thread.id); });
  }
  member(threadId, actorId) {
    const thread = this.store.require('thread', threadId); this.retireExpired(thread);
    if (thread.kind !== 'group' || !thread.memberIds.includes(actorId)) groupError(403, 'membership_required', '你已不在这个群聊中');
    if (actorId !== 'self') { const room = this.current(threadId); if (this.store.require('contact', actorId).externalGuest && !room) groupError(403, 'invitation_missing', '这个群聊没有开放访问'); if (room?.state === 'published' || this.store.require('contact', actorId).externalGuest) this.active(room); }
    return thread;
  }
  prepare(threadId, body, inTransaction = false) {
    groupFields(body, ['clientId', 'brief', 'hostName', 'agents', 'maxGuests', 'maxTurns', 'ttlHours', 'template']);
    const thread = this.member(threadId, 'self');
    if (!Array.isArray(body.agents) || !body.agents.length || body.agents.length > 10) groupError(400, 'agents_required', '请选择公开的 Agent 及其角色说明');
    const agents = body.agents.map(item => {
      groupFields(item, ['contactId', 'persona']);
      const contact = this.store.require('contact', item.contactId);
      if (!thread.memberIds.includes(contact.id) || contact.kind !== 'agent' || contact.binding?.type !== 'local' || !['codex', 'pi'].includes(contact.binding.localAgentId)) groupError(400, 'unsupported_agent', '公开群聊暂支持群内的本机 Codex 和 Pi');
      const publicContact = this.messenger.publicContact(contact);
      if (contact.binding.localAgentId === 'codex' && (publicContact.profile?.guestCompatible === false || publicContact.execution && publicContact.execution.provider !== 'openai')) groupError(409, 'guest_configuration_unsupported', '请使用兼容公开群聊的 Codex 内置配置或 Pi');
      return { contactId: contact.id, persona: groupText(item.persona, 1500), backend: contact.binding.localAgentId, binding: structuredClone(contact.binding), executionSnapshot: publicContact.execution || contact.executionSnapshot };
    });
    if (new Set(agents.map(a => a.contactId)).size !== agents.length) groupError(400, 'invalid_input', 'Agent 不能重复');
    const brief = groupText(body.brief, 6000), hostName = groupText(body.hostName, 40, this.store.require('contact', 'self').name);
    const maxGuests = integer(body.maxGuests, 5, 10), maxTurns = integer(body.maxTurns, 30, 30), ttlHours = integer(body.ttlHours, 24, 72);
    const effect = () => {
      if (this.current(threadId)) groupError(409, 'sharing_exists', '这个群已有邀请，请先结束后再调整公开背景');
      for (const old of this.store.list('play_room').filter(r => r.threadId === threadId && !r.closedAt)) {
        old.closedAt = this.stamp(); for (const participant of old.participants.filter(p => !p.isOwner && !p.removedAt)) participant.removedAt = this.stamp(); this.store.put('play_room', old);
      }
      const retired = thread.memberIds.filter(contactId => this.store.require('contact', contactId).externalGuest);
      if (retired.length) { thread.memberIds = thread.memberIds.filter(contactId => !retired.includes(contactId)); thread.members = thread.members.filter(m => !retired.includes(m.contactId)); thread.version++; this.store.put('thread', thread); }
      const roomId = id('pr'), token = randomBytes(32).toString('base64url');
      const credential = { id: roomId, type: 'play-invite', url: `https://agentroom.invalid/${roomId}`, credentialVersion: 1 };
      credential.credentialRef = this.store.vault.create(token, credential);
      const room = { id: roomId, threadId, state: 'draft', title: thread.title, template: body.template || 'project', brief, hostName, agents,
        agentName: agents.map(a => this.store.require('contact', a.contactId).name).join('、'), backend: agents[0].backend,
        maxGuests, maxTurns, turns: 0, version: 1, scopeVersion: 1, createdAt: this.stamp(), expiresAt: new Date(this.clock() + ttlHours * 3600000).toISOString(),
        credential, inviteHash: digest(token), participants: [{ id: 'self', name: hostName, isOwner: true, joinedAt: this.stamp() }], artifactGrants: [] };
      this.store.put('play_room', room); return { id: roomId };
    };
    const result = inTransaction ? effect() : this.store.idempotent(`group:prepare:${threadId}`, body.clientId, body, effect);
    this.changed(); return this.owner(result.id);
  }
  publish(threadId, body, inTransaction = false) {
    groupFields(body, ['clientId', 'version', 'shareId']);
    const room = typeof body.shareId === 'string' ? this.store.get('play_room', body.shareId) : null;
    if (!room || room.threadId !== threadId || this.current(threadId)?.id !== room.id) groupError(409, 'invitation_changed', '这份邀请已经更换，请重新查看公开范围后确认');
    if (!room) groupError(404, 'not_found', '请先准备公开邀请');
    let published = false;
    const effect = () => {
      const current = this.store.require('play_room', room.id), thread = this.member(threadId, 'self');
      if (current.version !== body.version) groupError(409, 'version_conflict', '群信息已更新，请重新确认');
      if (current.state !== 'draft') groupError(409, 'already_published', '邀请已经开放');
      for (const agent of current.agents) this.validateAgent(thread, agent);
      current.state = 'published'; current.boundaryMessageId = thread.messages.at(-1)?.id || null; current.publishedAt = this.stamp(); current.version++; published = true;
      this.store.put('play_room', current); return { accepted: true };
    };
    if (inTransaction) effect(); else this.store.idempotent(`group:publish:${room.id}`, body.clientId, body, effect);
    if (published) queueMicrotask(() => { if (this.closed || !this.store.get('play_room', room.id)) return; for (const run of this.store.require('thread', threadId).runs.filter(r => !r.sharedGroup && !terminal(r))) this.options.worker?.cancel(threadId, run.id); void this.options.openNetwork?.()?.catch?.(() => {}); });
    this.changed(); return this.owner(room.id);
  }
  info(threadId, viewerId = 'self') {
    const thread = this.member(threadId, viewerId), room = this.current(threadId);
    return room ? this.project(room, viewerId) : { threadId, legacyJobs: viewerId === 'self' ? this.legacyJobs(threadId) : [], uncertainRuns: viewerId === 'self' ? this.uncertainRuns(threadId) : [], migrationWarnings: viewerId === 'self' ? this.migrationWarnings(threadId) : [], thread: { id: thread.id, title: thread.title }, share: null, roster: this.roster(thread) };
  }
  roster(thread, publicScope = false) {
    this.retireExpired(thread);
    const room = this.current(thread.id);
    return thread.memberIds.filter(contactId => !publicScope || !room || contactId === 'self' || room.agents.some(a => a.contactId === contactId) || room.participants.some(p => p.id === contactId && !p.removedAt)).map(contactId => {
      const contact = this.store.require('contact', contactId), guest = room?.participants.find(p => p.id === contactId && !p.removedAt);
      const runs = thread.runs.filter(r => r.contactId === contactId && !terminal(r));
      return { ...person(contact), name: contactId === 'self' && room ? room.hostName : contact.name, membership: 'joined',
        presence: contactId === 'self' ? 'host' : contact.kind === 'agent' ? 'unknown' : guest?.lastSeenAt && this.clock() - Date.parse(guest.lastSeenAt) < 45000 ? 'recently_active' : 'unknown',
        execution: contact.kind !== 'agent' ? null : runs.some(r => r.status === 'unknown' || r.stopUnconfirmed || r.requiresReconciliation) ? 'unknown' : runs.some(r => ['blocked', 'needs_input'].includes(r.status)) ? 'waiting_owner' : runs.some(r => ['running', 'verifying'].includes(r.status)) ? 'running' : runs.some(r => r.status === 'queued') ? 'queued' : this.messenger.publicContact(contact).availability === 'ready' ? 'ready' : 'unavailable' };
    });
  }
  publicMessages(thread, room) {
    return thread.messages.filter(message => message.groupShareId === room.id || message.runId && thread.runs.some(run => run.id === message.runId && run.sharedGroup?.id === room.id && this.canPublishRun(thread, run)))
      .map(message => ({ id: message.id, role: message.role, contactId: message.contactId, text: message.text, createdAt: message.createdAt,
        ...(message.runId ? { runId: message.runId } : {}), ...(message.replyTo ? { replyTo: message.replyTo } : {}), attachments: [],
        reactions: (message.reactions || []).filter(r => thread.memberIds.includes(r.contactId)).map(r => ({ emoji: r.emoji, contactId: r.contactId, createdAt: r.createdAt })) }));
  }
  project(room, actorId) {
    const thread = this.store.require('thread', room.threadId), roster = this.roster(thread, actorId !== 'self');
    const messages = this.publicMessages(thread, room), runs = thread.runs.filter(r => r.sharedGroup?.id === room.id && (r.sharedPublishedAt || this.canPublishRun(thread, r))).map(r => ({ id: r.id, contactId: r.contactId, contactSnapshot: roster.find(p => p.id === r.contactId), mode: 'codex', messageId: r.messageId, status: r.status, createdAt: r.createdAt, deliveryState: r.deliveryState, ...(['blocked', 'failed', 'unknown'].includes(r.status) ? { error: '这次回复需要主人核查，可以继续整理群作品。' } : {}) }));
    return { id: room.id, threadId: thread.id, title: thread.title, template: room.template, brief: room.brief, hostName: room.hostName, agentName: room.agentName,
      expiresAt: room.expiresAt, closed: Boolean(room.closedAt) || Date.parse(room.expiresAt) <= this.clock(), version: room.version,
      share: { id: room.id, state: room.state, version: room.version, maxGuests: room.maxGuests, maxTurns: room.maxTurns, agents: room.agents?.map(({ contactId, persona }) => ({ contactId, persona })) },
      ...(actorId === 'self' ? { legacyJobs: this.legacyJobs(thread.id), uncertainRuns: this.uncertainRuns(thread.id), migrationWarnings: this.migrationWarnings(thread.id) } : {}),
      roster, contacts: roster, participants: roster.filter(p => p.kind === 'human').map(p => ({ ...p, isOwner: p.id === 'self' })), me: roster.find(p => p.id === actorId),
      remainingTurns: Math.max(0, room.maxTurns - room.turns),
      thread: { id: thread.id, kind: 'group', title: thread.title, groupAvatar: thread.groupAvatar, memberIds: roster.map(p => p.id), version: thread.version,
        status: thread.status, createdAt: thread.createdAt, updatedAt: thread.updatedAt, messages, runs, artifacts: [], decisions: [], events: [], memoryIds: [] },
      messages, jobs: runs.map(r => ({ ...r, actorId: thread.runs.find(run => run.id === r.id).sharedGroup.actorId })), artifacts: this.artifacts?.list(thread.id, actorId) || [] };
  }
  authenticate(roomId, cookie) {
    const actor = super.authenticate(roomId, cookie), room = this.store.require('play_room', roomId); this.member(room.threadId, actor);
    const participant = room.participants.find(p => p.id === actor);
    if (!participant.lastSeenAt || this.clock() - Date.parse(participant.lastSeenAt) > 15000) { participant.lastSeenAt = this.stamp(); this.store.put('play_room', room); }
    return actor;
  }
  join(body) {
    groupFields(body, ['invite', 'nickname', 'clientId']); const room = this.byInvite(body.invite), name = groupText(body.nickname, 32);
    const legacy = this.store.replay(`play:join:${room.id}`, body.clientId, { nickname: name });
    const accepted = legacy.found ? legacy.value : this.store.idempotent(`group:join:${room.id}`, body.clientId, { nickname: name }, () => {
      const current = this.store.require('play_room', room.id); this.active(current); const thread = this.store.require('thread', current.threadId);
      if (current.participants.filter(p => !p.isOwner && !p.removedAt).length >= current.maxGuests) groupError(429, 'guest_limit', '这次邀请的名额已满');
      const actorId = id('guest');
      this.store.put('contact', { id: actorId, name, handle: actorId.replaceAll('-', '').slice(0, 31), kind: 'human', groupId: thread.id, externalGuest: true, color: 'teal', version: 1, createdAt: this.stamp() });
      current.participants.push({ id: actorId, name, joinedAt: this.stamp(), lastSeenAt: this.stamp() }); current.version++;
      thread.memberIds.push(actorId); thread.members.push({ contactId: actorId, membershipId: id('membership'), visibleAfterMessageId: current.boundaryMessageId }); thread.version++;
      this.store.put('thread', thread); this.store.put('play_room', current); return { actorId };
    });
    const current = this.store.require('play_room', room.id);
    if (!current.participants.some(p => p.id === accepted.actorId && !p.removedAt)) groupError(401, 'guest_removed', '你已离开这个群聊');
    const secret = randomBytes(32).toString('base64url');
    this.store.put('play_session', { id: digest(`${room.id}:${body.clientId}`), hash: digest(secret), roomId: room.id, actorId: accepted.actorId, expiresAt: room.expiresAt });
    this.changed(); return { secret, room: this.project(current, accepted.actorId) };
  }
  prepareMessage(thread, body, actorId) {
    this.retireExpired(thread);
    const room = this.current(thread.id); if (!room || room.state !== 'published') return null;
    this.active(room); this.member(thread.id, actorId);
    groupText(body.text, 4000);
    if (thread.messages.filter(m => m.groupShareId === room.id).length >= 300) groupError(429, 'message_limit', '本次邀请的消息已满，请主人结束后重新邀请');
    if (body.attachments?.length || body.memoryIds?.length || body.action) groupError(400, 'public_scope', '公开群聊只接受消息文字；文件请通过群作品明确分享');
    if (body.replyTo && !this.publicMessages(thread, room).some(m => m.id === body.replyTo)) groupError(403, 'private_message', '这条消息没有公开到当前邀请');
    return room;
  }
  validateAgent(thread, agent) {
    const contact = this.store.get('contact', agent.contactId), expected = agent.binding || { type: 'local', localAgentId: agent.backend };
    if (!contact || !thread.memberIds.includes(agent.contactId) || JSON.stringify(contact.binding) !== JSON.stringify(expected)) groupError(409, 'published_agent_changed', '公开 Agent 的成员或执行绑定已变化，请结束这次邀请后重新审核');
  }
  agentAllowed(thread, contactId) { const room = this.current(thread.id); if (!room || room.state !== 'published') return true; const agent = room.agents.find(a => a.contactId === contactId); if (agent) this.validateAgent(thread, agent); return Boolean(agent); }
  validateDispatch(thread, inputs) {
    const room = this.current(thread.id); if (!room || room.state !== 'published') return;
    const pending = this.store.list('thread').flatMap(t => t.runs).filter(r => r.sharedGroup && ['queued', 'running', 'verifying'].includes(r.status));
    if (pending.length + inputs.length > 20) groupError(429, 'queue_full', '任务有点多，请稍后再试');
    if (room.turns + inputs.length > room.maxTurns) groupError(429, 'turn_limit', '本次邀请的 Agent 次数已用完');
  }
  canUseTools(thread, run) { return run.sharedGroup ? this.canPublishRun(thread, run) : this.current(thread.id)?.state !== 'published'; }
  prepareRun(thread, input, body, actorId) {
    const room = this.current(thread.id); if (!room || room.state !== 'published') return input;
    const agent = room.agents.find(a => a.contactId === input.contactId);
    if (!agent) groupError(403, 'agent_not_published', '请先在邀请范围中明确这位 Agent 的公开角色');
    return { ...input, mode: 'codex', localAgentId: agent.backend, connectionId: null, executionSnapshot: agent.executionSnapshot,
      memoryIds: [], attachments: [], contactSnapshot: { ...person(this.store.require('contact', input.contactId)), instructions: agent.persona },
      participantSnapshot: this.roster(thread),
      sharedGroup: { id: room.id, actorId, scopeVersion: room.scopeVersion, contactMembershipId: thread.members.find(m => m.contactId === input.contactId)?.membershipId, actorMembershipId: thread.members.find(m => m.contactId === actorId)?.membershipId } };
  }
  acceptedMessage(room, count) { if (room) { const current = this.store.require('play_room', room.id); current.turns += count; current.version++; this.store.put('play_room', current); } }
  send(threadId, actorId, body) {
    const thread = this.member(threadId, actorId); const room = this.current(threadId); if (actorId !== 'self') this.active(room);
    const result = this.messenger.appendMessage(thread, body, this.options.validateInput, actorId); this.changed(); this.kick(); return result;
  }
  uncertainRuns(threadId) { return this.store.require('thread', threadId).runs.filter(r => r.sharedGroup && r.stopUnconfirmed).map(r => ({ id: r.id, status: r.status })); }
  acknowledgeRun(threadId, body) {
    groupFields(body, ['clientId', 'runId', 'confirmedStopped']); this.member(threadId, 'self');
    this.store.idempotent(`group:run-stop:${threadId}`, body.clientId, body, () => {
      const thread = this.store.require('thread', threadId), run = thread.runs.find(r => r.id === body.runId);
      if (!run?.sharedGroup || !run.stopUnconfirmed || run.status !== 'unknown' || body.confirmedStopped !== true) groupError(409, 'review_required', '请先在本机核查原执行确实已经停止');
      Object.assign(run, { status: 'failed', stopUnconfirmed: false, requiresReconciliation: false, cancelPending: false, error: '主人已核查原执行结束，没有重发。' }); this.store.refreshThread(thread); this.store.put('thread', thread); return { accepted: true };
    }); this.changed(); this.kick(); return this.info(threadId);
  }
  migrationWarnings(threadId) { return this.store.list('play_room').filter(r => r.threadId === threadId && r.groupArtifactsMigrationError).map(r => ({ id: r.id, text: [r.board?.notes || '', ...(r.board?.tasks || []).map(t => `- [${t.done ? 'x' : ' '}] ${t.label}`), ...(r.board?.choices || []).map(c => `${c.label}：${c.votes?.length || 0} 票`)].filter(Boolean).join('\n') })); }
  legacyJobs(threadId) {
    const rooms = this.store.list('play_room').filter(r => r.threadId === threadId).map(r => r.id);
    return this.store.list('play_job').filter(j => rooms.includes(j.roomId) && j.status === 'unknown').map(j => ({ id: j.id, roomId: j.roomId, status: j.status }));
  }
  action(roomId, actorId, body) {
    if (body?.type === 'acknowledge') {
      groupFields(body, ['type', 'clientId', 'jobId', 'confirmedStopped']);
      if (actorId !== 'self') groupError(403, 'owner_required', '只有主人可以核查旧执行');
      this.store.idempotent(`group:legacy-stop:${roomId}`, body.clientId, body, () => {
        const job = this.store.require('play_job', body.jobId);
        if (job.roomId !== roomId || job.status !== 'unknown' || body.confirmedStopped !== true) groupError(409, 'review_required', '请先核查原执行确实已经停止');
        this.store.put('play_job', { ...job, status: 'failed', error: '主人已核查原执行结束，没有重发。' }); return { accepted: true };
      }); this.changed(); return this.project(this.store.require('play_room', roomId), actorId);
    }
    const room = this.store.require('play_room', roomId); this.member(room.threadId, actorId); if (!(actorId === 'self' && body?.type === 'close' && room.state === 'draft')) this.active(room);
    const allowed = { reaction: ['messageId', 'emoji', 'active'], message: ['text', 'replyTo'], close: [], remove: ['participantId'], artifact_create: ['kind', 'title', 'text', 'choices'], artifact_edit: ['artifactId', 'revisionId', 'hash', 'text'], artifact_act: ['artifactId', 'revisionId', 'choiceId'] };
    if (!Object.hasOwn(allowed, body?.type)) groupError(400, 'invalid_input', '不支持这个群聊操作');
    groupFields(body, ['type', 'clientId', ...allowed[body.type]]);
    if (['close', 'remove'].includes(body.type) && actorId !== 'self') groupError(403, 'owner_required', '只有主人可以管理邀请');
    if (body.type.startsWith('artifact_')) {
      if (!this.artifacts) groupError(503, 'unavailable', '作品暂时不可用');
      const { type, ...input } = body;
      if (type === 'artifact_create') this.artifacts.create(room.threadId, actorId, input);
      else if (type === 'artifact_edit') this.artifacts.editNote(room.threadId, actorId, input);
      else this.artifacts.act(room.threadId, actorId, input);
      return this.project(this.store.require('play_room', roomId), actorId);
    }
    if (this.store.replay(`play:action:${roomId}:${actorId}`, body.clientId, body).found) return this.project(this.store.require('play_room', roomId), actorId);
    this.store.idempotent(`group:action:${roomId}:${actorId}`, body.clientId, body, () => {
      if (body.type === 'message') this.send(room.threadId, actorId, { text: body.text, replyTo: body.replyTo });
      else if (body.type === 'reaction') {
        const thread = this.store.require('thread', room.threadId), message = thread.messages.find(m => m.id === body.messageId);
        if (!message || !this.publicMessages(thread, room).some(m => m.id === body.messageId) || !REACTIONS.includes(body.emoji) || typeof body.active !== 'boolean') groupError(400, 'invalid_reaction', '请选择本群已公开消息和支持的表情');
        if (body.active) addReaction(message, { emoji: body.emoji, contactId: actorId, contactSnapshot: person(this.store.require('contact', actorId)), recipientIds: [...thread.memberIds], createdAt: now() });
        else message.reactions = (message.reactions || []).filter(r => r.contactId !== actorId || r.emoji !== body.emoji);
        this.store.put('thread', thread);
      } else {
        const current = this.store.require('play_room', roomId), thread = this.store.require('thread', room.threadId);
        const targets = current.participants.filter(p => !p.isOwner && !p.removedAt && (body.type === 'close' || p.id === body.participantId));
        if (body.type === 'remove' && !targets.length) groupError(400, 'invalid_guest', '请选择仍在群中的访客');
        for (const participant of targets) { participant.removedAt = this.stamp(); thread.memberIds = thread.memberIds.filter(x => x !== participant.id); thread.members = thread.members.filter(x => x.contactId !== participant.id); }
        if (body.type === 'close') current.closedAt = this.stamp();
        else this.rotate(current);
        current.scopeVersion++; current.version++; thread.version++;
        this.store.put('thread', thread); this.store.put('play_room', current); this.cancelPublic(thread.id);
      }
      return { accepted: true };
    }); this.changed(); return this.project(this.store.require('play_room', roomId), actorId);
  }
  rotate(room) { const token = randomBytes(32).toString('base64url'); room.credential = { ...room.credential, credentialVersion: room.credential.credentialVersion + 1 }; room.credential.credentialRef = this.store.vault.create(token, room.credential); room.inviteHash = digest(token); }
  cancelPublic(threadId) { for (const run of this.store.require('thread', threadId).runs.filter(r => r.sharedGroup && !terminal(r))) this.options.worker?.cancel(threadId, run.id); }
  reconcile(threadId) {
    const room = this.current(threadId); if (!room) return;
    const thread = this.store.require('thread', threadId);
    const removed = room.participants.filter(p => !p.isOwner && !p.removedAt && !thread.memberIds.includes(p.id));
    for (const p of removed) p.removedAt = this.stamp();
    room.scopeVersion++; room.version++; if (removed.length) this.rotate(room); this.store.put('play_room', room); this.cancelPublic(threadId);
  }
  canPublishRun(thread, run) {
    if (!run.sharedGroup) return true;
    const room = this.store.get('play_room', run.sharedGroup.id), current = this.store.get('thread', thread.id);
    if (!room || !current || room.closedAt || room.state !== 'published' || Date.parse(room.expiresAt) <= this.clock() || room.scopeVersion !== run.sharedGroup.scopeVersion) return false;
    return [['contactId', 'contactMembershipId'], ['actorId', 'actorMembershipId']].every(([key, epoch]) => {
      const actor = key === 'contactId' ? run.contactId : run.sharedGroup.actorId;
      return current.memberIds.includes(actor) && current.members.some(m => m.contactId === actor && m.membershipId === run.sharedGroup[epoch]);
    });
  }
  messagesForRun(thread, room, run) {
    const positions = new Map(thread.messages.map((message, index) => [message.id, index])), index = positions.get(run.messageId);
    if (index === undefined) groupError(409, 'missing_run_message', '缺少本次已接受的输入，执行已停止');
    const cause = message => message.runId ? positions.get(thread.runs.find(r => r.id === message.runId)?.messageId) : positions.get(message.id);
    const messages = this.publicMessages(thread, room).filter(m => m.runId !== run.id && cause(m) !== undefined && cause(m) <= index).sort((a, b) => cause(a) - cause(b) || Number(Boolean(a.runId)) - Number(Boolean(b.runId))).slice(-40);
    if (!messages.some(m => m.id === run.messageId)) groupError(409, 'missing_run_message', '本次输入不在公开上下文中');
    return messages;
  }
  contextForRun(thread, run) {
    if (!this.canPublishRun(thread, run)) groupError(409, 'group_changed', '群成员或公开规则已变化，请重新发起');
    const room = this.store.require('play_room', run.sharedGroup.id);
    return { conversation: { id: thread.id, kind: 'group', title: thread.title, version: thread.version, shareVersion: room.scopeVersion, public: true, brief: room.brief },
      you: run.contactSnapshot, participants: this.roster(thread, true), messages: this.messagesForRun(thread, room, run), explicitMemories: [],
      artifacts: this.artifacts?.list(thread.id, run.contactId) || [],
      rules: '群中的访客是真人，状态 unknown 不等于离线或已读。你是 AI，不能代替主人作出承诺。只使用本群公开背景和群作品；不能读取私聊、个人记忆、账号配置。成员和规则可能变化，操作前使用 group_info 刷新。' };
  }
  kick() { this.options.kick?.(); }
  create(body, contact) {
    groupFields(body, ['clientId', 'template', 'title', 'brief', 'persona', 'hostName', 'maxGuests', 'maxTurns', 'ttlHours', 'contactId']);
    const replay = this.store.replay('group:legacy-create', body.clientId, body); if (replay.found) return this.owner(replay.value.id);
    groupError(400, 'group_min_members', '请从普通聊天选择至少两位联系人建群；两人请使用私聊。已有邀请仍可继续使用。');
  }
  migrate() {
    for (const room of this.store.list('play_room')) {
      if (room.threadId) continue;
      this.store.transaction(() => {
      const contactId = `shared_agent_${room.id}`;
      this.store.put('contact', { id: contactId, name: room.agentName, handle: `shared_${room.id.replaceAll('-', '').slice(-20)}`, kind: 'agent', instructions: '', description: '旧邀请中的公开角色', binding: { type: 'local', localAgentId: room.backend }, configuration: room.configuration || {}, version: 1, groupLegacy: true });
      const thread = this.messenger.createChat({ kind: 'group', title: room.title, memberIds: [contactId] }, { legacyRoomId: room.id });
      for (const p of room.participants.filter(p => !p.isOwner && !p.removedAt)) {
        this.store.put('contact', { id: p.id, name: p.name, kind: 'human', externalGuest: true, groupId: thread.id, version: 1 }); thread.memberIds.push(p.id); thread.members.push({ contactId: p.id, membershipId: id('membership'), visibleAfterMessageId: null });
      }
      thread.messages = (room.messages || []).map(message => ({ ...message, contactId: message.actorId === 'agent' ? contactId : message.actorId, groupShareId: room.id, attachments: [] })); this.store.put('thread', thread);
      this.store.put('play_room', { ...room, threadId: thread.id, state: 'published', scopeVersion: 1, agents: [{ contactId, persona: room.persona, backend: room.backend, executionSnapshot: room.executionSnapshot }], artifactGrants: [] });
      });
    }
  }
}
