import { APIError, id, now, digest } from './store.mjs';
import { ArtifactStore } from './artifact-store.mjs';
import { artifactTools, validateArtifactInput } from './artifact-tools.mjs';
import { CollaborationRuntime } from './collaboration-runtime.mjs';
import { resolveExecution } from './agent-profiles.mjs';

const fail = (status, code, message) => { throw new APIError(status, code, message); };
const matches = (paths, path) => path === undefined || paths.some(pattern => pattern === '**' || pattern === path || (pattern.endsWith('/**') && path.startsWith(`${pattern.slice(0, -3)}/`)));
export function creationPaths(paths = ['**']) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 32 || paths.some(path => typeof path !== 'string' || path.length > 240 || !path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.includes(':') || path.split('/').some(part => ['.', '..', ''].includes(part)) || (path.includes('*') && path !== '**' && !/^[^*]+\/\*\*$/.test(path)))) fail(400, 'invalid_path', '请选择作品内的明确路径或目录/**');
  return [...new Set(paths.map(path => path.normalize('NFC')))];
}

/** Owner decisions and the single artifact-tool policy kernel. */
export class CreationService {
  constructor(store, options = {}) {
    this.store = store; this.options = options; this.clock = options.clock || Date.now; this.notify = options.notify || (() => {});
    this.artifacts = new ArtifactStore(store, { authorize: (...args) => this.authorize(...args) });
    this.runtime = new CollaborationRuntime(this, options);
  }
  context(threadId, runId, { allowYielded = false } = {}) {
    const thread = this.store.require('thread', threadId), run = thread.runs.find(item => item.id === runId);
    if (!run?.contactId || !['running', 'verifying'].includes(run.status) || !thread.memberIds?.includes(run.contactId)) fail(403, 'grant_revoked', '本次 Agent 执行已经停止或不再属于这个群聊');
    const contact = this.store.require('contact', run.contactId);
    if (contact.binding?.type !== 'local' || contact.binding.localAgentId !== run.localAgentId || !['codex', 'pi'].includes(run.localAgentId)) fail(403, 'binding_changed', '这次执行的助手绑定已经改变');
    const message = thread.messages.find(item => item.id === run.messageId);
    const context = { threadId, runId, messageId: run.messageId, contactId: run.contactId, localAgentId: run.localAgentId,
      mode: run.collaboration ? 'work' : 'conversation', audienceIds: [...(message?.recipientIds || run.participantSnapshot?.map(peer => peer.id) || thread.memberIds)].filter(contactId => thread.memberIds.includes(contactId)) };
    if (run.collaboration) {
      const work = this.store.require('collaboration', run.collaboration.workId), step = work.steps.find(item => item.id === run.collaboration.stepId);
      if (!step || step.contactId !== run.contactId || !(['running', 'verifying'].includes(step.status) || (allowYielded && step.status === 'waiting_dependency' && step.activeRunId === runId)) || ['cancelled', 'unknown'].includes(work.status)) fail(403, 'grant_revoked', '这次创作步骤已停止、等待依赖或需要核查');
      Object.assign(context, { workId: work.id, stepId: step.id, grantId: work.grantId, stageId: step.stageId, mandatoryPaths: step.mandatoryPaths || [], audienceIds: work.audienceIds, deferMaterialization: work.kind === 'website' });
      this.grant(context);
    }
    return context;
  }
  grant(context) {
    const grant = this.store.require('capability_grant', context.grantId), thread = this.store.require('thread', grant.threadId);
    const work = grant.workId ? this.store.get('collaboration', grant.workId) : null;
    if (work?.chatToolReads?.length && !this.options.chatTools?.canReadMessage({ chatToolReads: work.chatToolReads }, grant.audienceIds)) fail(403, 'grant_revoked', '共创所引用的聊天资料已不再向全部参与者开放');
    if (grant.state !== 'active' || grant.expiresAt <= this.clock() || grant.revokedContacts.includes(context.contactId) || !thread.memberIds.includes(context.contactId)) fail(403, 'grant_revoked', '创作授权已失效，请重新审核范围');
    const participant = grant.participants.find(item => item.contactId === context.contactId), contact = this.store.require('contact', context.contactId);
    if (!participant || contact.binding?.type !== 'local' || contact.binding.localAgentId !== participant.localAgentId) fail(403, 'binding_changed', '参与者的执行器已改变，原授权不能继续使用');
    return grant;
  }
  audienceBindings(ids) { return Object.fromEntries(ids.map(contactId => [contactId, JSON.stringify(this.store.require('contact', contactId).binding || null)])); }
  linkAllows(link, artifactId, revisionId) {
    let revision = this.store.get('artifact_revision', revisionId);
    if (!revision || revision.artifactId !== artifactId || revision.state !== 'committed') return false;
    if (revisionId === link.revisionId) return true;
    if (!link.follow || !revision.deliveredAt) return false;
    const seen = new Set();
    while (revision?.parentRevisionId && !seen.has(revision.id)) {
      seen.add(revision.id); revision = this.store.get('artifact_revision', revision.parentRevisionId);
      if (!revision || revision.artifactId !== artifactId || revision.state !== 'committed') return false;
      if (revision.id === link.revisionId) return true;
    }
    return false;
  }
  readDependenciesAllowed(threadId, reads, audienceIds) {
    const context = { mode: 'conversation', threadId, audienceIds };
    return (reads || []).every(read => read.kind === 'metadata' ? this.canRead(context, read.artifactId, read.revisionId) : (read.paths || []).every(path => this.canRead(context, read.artifactId, read.revisionId, path)));
  }
  canReadMessage(threadId, run, message) {
    const thread = this.store.require('thread', threadId), source = thread.messages.find(item => item.id === run.messageId);
    const audience = (source?.recipientIds || run.participantSnapshot?.map(peer => peer.id) || thread.memberIds).filter(contactId => thread.memberIds.includes(contactId));
    return this.readDependenciesAllowed(threadId, message.artifactReads, audience);
  }
  captureContextReads(threadId, runId, messages) {
    const reads = messages.flatMap(message => message.artifactReads || []); if (!reads.length) return;
    this.store.updateThread(threadId, thread => { const run = thread.runs.find(item => item.id === runId); run.artifactReads = [...new Map([...(run.artifactReads || []), ...reads].map(read => [JSON.stringify(read), read])).values()]; });
  }
  recordRead(context, read) {
    this.store.updateThread(context.threadId, thread => { const run = thread.runs.find(item => item.id === context.runId); run.artifactReads = [...new Map([...(run.artifactReads || []), read].map(item => [JSON.stringify(item), item])).values()]; });
  }
  contributorRun(proposal, contributor) { return contributor.runId || this.store.require('thread', proposal.threadId).runs.find(run => run.messageId === proposal.messageId && run.contactId === contributor.contactId && !run.collaboration)?.id; }
  cardAllowed(threadId, runId, audienceIds) {
    if (!runId) return false;
    const thread = this.store.require('thread', threadId), run = thread.runs.find(item => item.id === runId), source = thread.messages.find(item => item.id === run?.messageId);
    const accepted = source?.recipientIds || run?.participantSnapshot?.map(peer => peer.id) || [];
    return Boolean(run && audienceIds.every(contactId => accepted.includes(contactId)) && this.readDependenciesAllowed(threadId, run.artifactReads, audienceIds)
      && (!run.chatToolReads?.length || this.options.chatTools?.canReadMessage({ chatToolReads: run.chatToolReads }, audienceIds)));
  }
  canRead(context, artifactId, revisionId, path) {
    if (context.owner) return true;
    if (context.mode === 'work') {
      const grant = this.grant(context);
      if (grant.artifactId !== artifactId) return grant.extraReads.some(read => read.artifactId === artifactId && read.revisionId === revisionId && matches(read.paths, path));
      if (!matches(grant.readPaths, path)) return false;
      if (revisionId === null || grant.baseRevisionId === revisionId || grant.producedRevisionIds.includes(revisionId)) return true;
      const revision = this.store.get('artifact_revision', revisionId);
      return revision?.state === 'candidate' && revision.artifactId === artifactId && revision.contributionIds.every(contributionId => this.store.require('artifact_contribution', contributionId).runId === context.runId);
    }
    const thread = this.store.require('thread', context.threadId);
    const links = this.store.list('artifact_link').filter(link => link.threadId === context.threadId && link.artifactId === artifactId && link.state === 'active');
    return context.audienceIds.every(contactId => contactId === 'self' || (thread.memberIds.includes(contactId) && links.some(link => link.audienceIds.includes(contactId) && link.audienceBindings?.[contactId] === JSON.stringify(this.store.require('contact', contactId).binding || null) && matches(link.paths, path) && this.linkAllows(link, artifactId, revisionId))));
  }
  authorize(context, capability, artifactId, path, revisionId) {
    if (typeof path === 'string') path = path.normalize('NFC');
    if (context?.owner && capability !== 'create') return;
    if (!context) fail(403, 'permission_required', '缺少作品授权');
    if (capability === 'read') { if (!this.canRead(context, artifactId, revisionId, path)) fail(403, 'permission_required', '这个版本或文件尚未向全部接收者共享'); return; }
    const grant = this.grant(context);
    if (capability === 'create') { if (grant.artifactId) fail(409, 'artifact_exists', '这次计划已经有作品'); return; }
    if (grant.artifactId !== artifactId) fail(403, 'permission_required', '授权不包含这个作品');
    if (capability === 'merge') {
      const artifact = this.store.require('workspace_artifact', artifactId);
      if (!this.canRead(context, artifactId, artifact.headRevisionId)) fail(403, 'permission_required', '作品已有未共享的更新，请先核对共享版本');
      return;
    }
    const participant = grant.participants.find(item => item.contactId === context.contactId);
    if (!participant || !matches(participant.writePaths, path)) fail(403, 'permission_required', '这个文件不在已批准的修改范围内');
  }
  visibleArtifacts(context) {
    if (context.mode === 'work') {
      const grant = this.grant(context); if (!grant.artifactId) return [];
      const artifact = this.store.require('workspace_artifact', grant.artifactId);
      return [{ id: artifact.id, title: artifact.title, kind: artifact.kind, revisionId: grant.producedRevisionIds.at(-1) || grant.baseRevisionId }];
    }
    return this.store.list('artifact_link').filter(link => link.threadId === context.threadId && link.state === 'active').flatMap(link => {
      const artifact = this.store.get('workspace_artifact', link.artifactId), revisionId = link.follow ? artifact?.deliveredRevisionId || link.revisionId : link.revisionId;
      return artifact && this.canRead(context, artifact.id, revisionId) ? [{ id: artifact.id, title: artifact.title, kind: artifact.kind, revisionId }] : [];
    });
  }
  call(original, name, args, callId) {
    if (original.signal?.aborted) fail(403, 'grant_revoked', '本次工具会话已撤销');
    const context = this.context(original.threadId, original.runId), tool = artifactTools(context.mode).find(item => item.name === name);
    if (!tool) fail(403, 'tool_unavailable', '本次会话没有这个工具；需要先提出计划并由用户批准');
    validateArtifactInput(tool.inputSchema, args);
    if (context.mode === 'conversation' && ['creation_propose', 'creation_update', 'permission_request'].includes(name) && !this.canPublishConversation(context.threadId, context.runId)) fail(403, 'permission_required', '已读取资料的共享范围发生改变，不能发布到这张群卡');
    const operationId = `tool_${digest(`${context.runId}:${callId}`).slice(0, 40)}`, hash = digest(JSON.stringify({ name, args })), previous = this.store.get('artifact_tool_operation', operationId);
    if (previous) {
      if (previous.hash !== hash) fail(409, 'idempotency_conflict', '同一工具标识的参数已改变');
      if (previous.state === 'pending') fail(409, 'operation_unknown', '原工具作用尚未核查，不能重复执行');
      if (!previous.ok) fail(previous.error.status, previous.error.code, previous.error.message);
      if (name === 'artifact_read') for (const file of previous.result.files || []) this.authorize(context, 'read', previous.artifactId, file.path, previous.revisionId);
      if (name === 'artifact_list') for (const artifact of previous.result.artifacts) this.authorize(context, 'read', artifact.id, undefined, artifact.revisionId);
      return name === 'artifact_read' ? this.artifacts.replayRead(previous.result, context) : previous.result;
    }
    this.store.transaction(() => {
      if (context.mode === 'work') { const grant = this.grant(context); if (grant.calls >= 200) fail(429, 'budget_exceeded', '本轮共创工具预算已用完'); grant.calls++; this.store.put('capability_grant', grant); }
      const operation = { id: operationId, ...context, name, hash, state: 'pending', createdAt: now() }; this.store.put('artifact_tool_operation', operation); this.receipt(operation);
    });
    try {
      let result;
      if (name === 'artifact_list') { result = { artifacts: this.visibleArtifacts(context) }; for (const artifact of result.artifacts) this.recordRead(context, { kind: 'metadata', artifactId: artifact.id, revisionId: artifact.revisionId }); }
      else if (name === 'creation_propose') result = this.propose(context, args);
      else if (name === 'creation_update') result = this.update(context, args);
      else if (name === 'permission_request') result = this.requestPermission(context, args);
      else if (name === 'artifact_read') result = this.read(context, args);
      else if (name === 'collaboration_status' && context.mode === 'conversation') result = { proposals: this.forThread(context.threadId).proposals.filter(proposal => proposal.messageId === context.messageId).map(proposal => ({ id: proposal.id, title: proposal.title, kind: proposal.kind, goal: proposal.goal, version: proposal.version, state: proposal.state, contributors: proposal.contributors })) };
      else result = this.runtime.tool(context, name, args);
      if (name === 'artifact_read' && result.files.reduce((size, file) => size + Buffer.byteLength(file.text || ''), 0) > 1_500_000) result = { ...result, contentOmitted: true, notice: '内容超过单次工具返回预算；请按 files 中的路径分批 artifact_read。' };
      const saved = name === 'artifact_read' ? this.artifacts.captureRead(result) : result;
      const operation = this.store.put('artifact_tool_operation', { ...this.store.require('artifact_tool_operation', operationId), state: 'completed', ok: true, result: saved,
        ...(name === 'artifact_read' ? { artifactId: result.artifactId, revisionId: result.revisionId } : {}), finishedAt: now() }); this.receipt(operation);
      if (name === 'artifact_read' && result.contentOmitted) result = saved;
      this.notify({ threadId: context.threadId }); return result;
    } catch (error) {
      const safe = { status: error.status || 500, code: error.code || 'tool_failed', message: error.status ? error.message : '工具未完成，请核对执行记录' };
      const operation = this.store.put('artifact_tool_operation', { ...this.store.require('artifact_tool_operation', operationId), state: 'completed', ok: false, error: safe, finishedAt: now() }); this.receipt(operation);
      this.notify({ threadId: context.threadId }); throw new APIError(safe.status, safe.code, safe.message);
    }
  }
  receipt({ id, threadId, contactId, name, state, ok, createdAt }) { this.store.put('artifact_tool_receipt', { id, threadId, contactId, name, state, ok, createdAt }); }
  validateSessionCall(threadId, runId, name, args, callId) {
    const operation = this.store.get('artifact_tool_operation', `tool_${digest(`${runId}:${callId}`).slice(0, 40)}`);
    const context = this.context(threadId, runId, { allowYielded: name === 'task_yield' && operation?.ok === true });
    if (context.mode === 'conversation' && ['creation_propose', 'creation_update', 'permission_request'].includes(name) && !this.canPublishConversation(threadId, runId)) fail(403, 'permission_required', '已读取资料不再向全部接收者开放');
    if (name === 'artifact_list' && operation?.ok) for (const artifact of operation.result.artifacts) this.authorize(context, 'read', artifact.id, undefined, artifact.revisionId);
    if (name === 'artifact_read' && operation?.ok) for (const file of operation.result.files || []) this.authorize(context, 'read', operation.artifactId, file.path, operation.revisionId);
    return context;
  }
  read(context, args) {
    if (context.mode === 'work' && !args.artifactId) {
      const grant = this.grant(context), read = this.artifacts.readStage(context.stageId, context, args.paths);
      return { artifactId: grant.artifactId, revisionId: read.baseRevisionId, files: read.files };
    }
    const visible = this.visibleArtifacts(context).find(artifact => artifact.id === args.artifactId);
    const revisionId = args.revisionId || visible?.revisionId;
    if (!args.artifactId || !revisionId) fail(403, 'permission_required', '请先选择已共享的作品版本');
    const read = this.artifacts.read(args.artifactId, revisionId, context.mode === 'work' && this.grant(context).artifactId !== args.artifactId ? { ...context, stageId: undefined } : context, args.paths);
    this.recordRead(context, { artifactId: args.artifactId, revisionId, paths: read.files.map(file => file.path), ...(!read.files.length ? { kind: 'metadata' } : {}) });
    return { artifactId: args.artifactId, revisionId, files: read.files };
  }
  sourceParticipants(thread, messageId) {
    return thread.runs.filter(run => !run.collaboration && run.messageId === messageId && run.contactId && ['codex', 'pi'].includes(run.localAgentId)).map(run => ({ contactId: run.contactId, localAgentId: run.localAgentId, contactSnapshot: run.contactSnapshot, executionSnapshot: run.executionSnapshot }));
  }
  propose(context, input) {
    const thread = this.store.require('thread', context.threadId), proposalId = `creation_${digest(`${thread.id}:${context.messageId}`).slice(0, 32)}`;
    let proposal = this.store.get('creation_proposal', proposalId);
    if (proposal && !['draft', 'ready', 'needs_input'].includes(proposal.state)) fail(409, 'proposal_sealed', '这个计划已经处理，请用新的消息提出下一轮修改');
    const writePaths = creationPaths(input.writePaths), participants = this.sourceParticipants(thread, context.messageId);
    if ((input.dependsOnContacts || []).some(contactId => contactId === context.contactId || !participants.some(participant => participant.contactId === contactId))) fail(400, 'invalid_dependency', '依赖必须指向本轮另一位可执行伙伴');
    if (!proposal) {
      const visible = input.artifactId && this.visibleArtifacts(context).find(item => item.id === input.artifactId);
      if (input.artifactId && !visible) fail(403, 'permission_required', '请先把这个作品明确共享到当前群聊');
      proposal = { id: proposalId, threadId: thread.id, messageId: context.messageId, title: visible?.title || input.title, kind: visible?.kind || input.kind,
        goal: input.goal, artifactId: visible?.id || null, baseRevisionId: visible?.revisionId || null, participants, audienceIds: context.audienceIds,
        readPaths: ['**'], publishPaths: ['**'], inputs: this.inputReferences(thread, context.messageId), audienceBindings: this.audienceBindings(context.audienceIds),
        contributors: [], version: 0, state: 'draft', createdAt: now(), sourceNames: (thread.messages.find(message => message.id === context.messageId)?.attachments || []).map(item => item.name) };
    }
    if ((input.artifactId || null) !== proposal.artifactId || input.kind !== proposal.kind) fail(409, 'proposal_direction_conflict', `本轮整件作品的类型为 ${proposal.kind}，artifactId 为 ${proposal.artifactId || '新作品（省略 artifactId）'}。kind 不是你负责的文件类型；Markdown 设计说明也属于这件 ${proposal.kind}。请调用 creation_update，proposalId=${proposal.id}、version=${proposal.version}，提交你自己的 task、writePaths 和依赖，不要重新声明作品方向。`);
    const contribution = { contactId: context.contactId, runId: context.runId, task: input.task, notes: input.notes || '', writePaths, dependsOnContacts: input.dependsOnContacts || [] };
    proposal.contributors = [...proposal.contributors.filter(item => item.contactId !== context.contactId), contribution];
    proposal.state = 'draft'; proposal.version++; proposal.updatedAt = now(); this.store.put('creation_proposal', proposal);
    return { proposalId, state: proposal.state, version: proposal.version, contributors: proposal.contributors.map(item => ({ contactId: item.contactId, task: item.task })), notice: '已加入共同方案，等待本轮讨论结束和用户审核；尚未开始创作' };
  }
  update(context, input) {
    const proposal = this.store.require('creation_proposal', input.proposalId), own = proposal.contributors.find(item => item.contactId === context.contactId);
    if (proposal.threadId !== context.threadId || proposal.messageId !== context.messageId || proposal.version !== input.version) fail(409, 'version_conflict', '方案已更新或不属于本次讨论');
    if (!own && !input.task) fail(400, 'invalid_request', '加入方案时请提供你自己的 task 和文件范围');
    return this.propose(context, { ...own, ...input, title: proposal.title, kind: proposal.kind, goal: proposal.goal, ...(proposal.artifactId ? { artifactId: proposal.artifactId } : {}) });
  }
  seal(threadId, messageId, force = false) {
    const proposal = this.store.list('creation_proposal').find(item => item.threadId === threadId && item.messageId === messageId && ['draft', 'needs_input'].includes(item.state));
    if (!proposal) return;
    const thread = this.store.require('thread', threadId), runs = thread.runs.filter(run => run.messageId === messageId && !run.collaboration);
    if (!force && runs.some(run => ['queued', 'running', 'verifying'].includes(run.status))) return;
    const ids = new Set(proposal.contributors.map(item => item.contactId)), visiting = new Set(), visited = new Set();
    const visit = contactId => {
      if (visiting.has(contactId)) fail(400, 'dependency_cycle', '分工存在循环依赖，请调整方案');
      if (visited.has(contactId)) return;
      visiting.add(contactId);
      for (const dependency of proposal.contributors.find(item => item.contactId === contactId).dependsOnContacts) { if (!ids.has(dependency)) fail(400, 'missing_participant', '依赖的伙伴尚未提交分工，请调整方案'); visit(dependency); }
      visiting.delete(contactId); visited.add(contactId);
    };
    try { for (const contactId of ids) visit(contactId); proposal.state = 'ready'; delete proposal.error; }
    catch (error) { proposal.state = 'needs_input'; proposal.error = error.message; }
    proposal.planHash = digest(JSON.stringify({ title: proposal.title, kind: proposal.kind, goal: proposal.goal, artifactId: proposal.artifactId, baseRevisionId: proposal.baseRevisionId, audienceIds: proposal.audienceIds, audienceBindings: proposal.audienceBindings, inputs: proposal.inputs, readPaths: proposal.readPaths, publishPaths: proposal.publishPaths, contributors: proposal.contributors }));
    proposal.version++; this.store.put('creation_proposal', proposal); this.notify({ threadId }); return proposal;
  }
  decide(proposalId, body) {
    const result = this.store.idempotent(`creation:${proposalId}`, body.clientId, body, () => {
      const proposal = this.store.require('creation_proposal', proposalId);
      if (body.version !== proposal.version) fail(409, 'version_conflict', '共同方案已更新，请重新审核');
      const allowedStates = body.choice === 'reject' ? ['ready', 'needs_input'] : ['ready'];
      if (!allowedStates.includes(proposal.state) || !['approve', 'reject'].includes(body.choice)) fail(409, 'inactive_proposal', '这个方案当前不能执行该决定');
      if (body.choice === 'reject') { proposal.state = 'rejected'; proposal.version++; this.store.put('creation_proposal', proposal); return { proposal, collaboration: null }; }
      const thread = this.store.require('thread', proposal.threadId);
      this.workInput(proposal);
      if (!proposal.contributors.every(item => this.cardAllowed(thread.id, this.contributorRun(proposal, item), thread.memberIds))) fail(403, 'permission_required', '原方案引用的资料不再向这个群开放，请重新共享后讨论');
      for (const contribution of proposal.contributors) {
        const participant = proposal.participants.find(item => item.contactId === contribution.contactId), contact = this.store.require('contact', contribution.contactId);
        if (!participant || !thread.memberIds.includes(contact.id) || contact.binding?.localAgentId !== participant.localAgentId) fail(409, 'binding_changed', '参与者或执行器已改变，请重新确定分工');
      }
      if (proposal.artifactId && this.store.require('workspace_artifact', proposal.artifactId).headRevisionId !== proposal.baseRevisionId) fail(409, 'version_conflict', '作品已有更新，请先选择要共享并修改的版本');
      const collaboration = this.runtime.create(proposal);
      proposal.state = 'approved'; proposal.version++; proposal.workId = collaboration.id; proposal.decidedAt = now(); this.store.put('creation_proposal', proposal);
      return { proposal, collaboration };
    });
    if (result.collaboration) this.runtime.enqueueNext(result.collaboration.id);
    this.notify({ threadId: result.proposal.threadId }); return result;
  }
  ownerUpdate(proposalId, body) {
    const result = this.store.idempotent(`creation-change:${proposalId}`, body.clientId, body, () => {
      const proposal = this.store.require('creation_proposal', proposalId);
      if (!['ready', 'needs_input'].includes(proposal.state) || proposal.version !== body.version) fail(409, 'version_conflict', '方案已经更新，请重新打开后调整');
      if (typeof body.goal !== 'string' || !body.goal.trim() || body.goal.length > 4000) fail(400, 'invalid_request', '请填写有效的作品目标');
      for (const values of [body.tasks, body.paths, body.dependencies]) if (values && (typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(contactId => !proposal.contributors.some(item => item.contactId === contactId)))) fail(400, 'invalid_request', '只能调整当前方案中的参与者');
      for (const contribution of proposal.contributors) {
        if (body.tasks?.[contribution.contactId] !== undefined) { const task = body.tasks[contribution.contactId]; if (typeof task !== 'string' || !task.trim() || task.length > 3000) fail(400, 'invalid_request', '请填写有效分工'); contribution.task = task; }
        if (body.paths?.[contribution.contactId]) contribution.writePaths = creationPaths(body.paths[contribution.contactId]);
        if (body.dependencies?.[contribution.contactId]) { const values = body.dependencies[contribution.contactId]; if (!Array.isArray(values) || values.some(contactId => contactId === contribution.contactId || !proposal.contributors.some(item => item.contactId === contactId))) fail(400, 'invalid_dependency', '请选择本轮另一位伙伴作为依赖'); contribution.dependsOnContacts = [...new Set(values)]; }
      }
      proposal.goal = body.goal.trim(); proposal.state = 'draft'; this.store.put('creation_proposal', proposal);
      return this.seal(proposal.threadId, proposal.messageId, true);
    });
    this.notify({ threadId: result.threadId }); return result;
  }
  share(artifactId, { threadId, revisionId, follow = false, paths = ['**'], revoke = false, expectedVersion }) {
    const artifact = this.store.require('workspace_artifact', artifactId), thread = this.store.require('thread', threadId);
    const existing = this.store.list('artifact_link').find(link => link.artifactId === artifactId && link.threadId === threadId);
    if (revoke) {
      if (!existing || (existing.version || 1) !== expectedVersion) fail(409, 'version_conflict', '共享范围已经改变，请重新查看后撤回');
      const link = this.store.put('artifact_link', { ...existing, state: 'revoked', version: (existing.version || 1) + 1 });
      for (const work of this.store.list('collaboration').filter(item => item.threadId === threadId && item.artifactId === artifactId && !['completed', 'cancelled'].includes(item.status))) this.store.put('collaboration', { ...work, publishRevoked: true });
      this.revokeSource(threadId, artifactId); this.notify({ threadId }); return link;
    }
    if (this.artifacts.revision(artifactId, revisionId).state !== 'committed') fail(400, 'invalid_revision', '只能共享已整合的确定版本');
    const link = { id: existing?.id || `link_${digest(`${artifactId}:${threadId}`).slice(0, 32)}`, artifactId: artifact.id, threadId, revisionId, follow: follow === true,
      paths: creationPaths(paths), audienceIds: [...thread.memberIds], audienceBindings: this.audienceBindings(thread.memberIds), version: (existing?.version || 0) + 1, state: 'active', createdAt: now() };
    this.store.put('artifact_link', link); for (const work of this.store.list('collaboration').filter(item => item.threadId === threadId && item.artifactId === artifactId && !['completed', 'cancelled'].includes(item.status))) this.store.put('collaboration', { ...work, publishRevoked: true }); this.notify({ threadId }); return link;
  }
  requestPermission(context, input) {
    if (input.capability !== 'artifact_read' && !input.paths?.length) fail(400, 'invalid_request', '修改和新增伙伴需要明确申请路径');
    if (input.capability === 'participant' && !input.contactId) fail(400, 'invalid_request', '请选择要加入的伙伴');
    const artifactId = input.artifactId || (context.grantId ? this.grant(context).artifactId : null);
    const target = this.store.get('contact', input.contactId || context.contactId);
    const request = { id: id('permission'), threadId: context.threadId, runId: context.runId, workId: context.workId || null, requestedBy: context.contactId,
      stepId: context.stepId || null, capability: input.capability, artifactId, revisionId: input.revisionId || (artifactId ? this.store.get('workspace_artifact', artifactId)?.headRevisionId || null : null), paths: creationPaths(input.paths), contactId: input.contactId || context.contactId,
      targetBinding: target?.binding?.type === 'local' ? { localAgentId: target.binding.localAgentId, version: target.version } : null,
      reason: input.reason, state: 'pending', version: 1, audienceIds: context.mode === 'work' ? [...new Set(['self', ...this.store.require('collaboration', context.workId).participants.map(item => item.contactId)])] : context.audienceIds, createdAt: now() };
    const previous = this.store.list('capability_request').find(item => item.state === 'pending' && item.threadId === request.threadId && item.workId === request.workId && item.capability === request.capability && item.artifactId === request.artifactId && item.contactId === request.contactId && JSON.stringify(item.paths) === JSON.stringify(request.paths));
    if (previous) return { requestId: previous.id, state: 'pending', notice: '已有相同范围的未决申请' };
    this.store.put('capability_request', request); return { requestId: request.id, state: request.state, notice: '已请求额外权限，尚未获得授权' };
  }
  decidePermission(requestId, body) {
    const result = this.store.idempotent(`permission:${requestId}`, body.clientId, body, () => {
      const request = this.store.require('capability_request', requestId);
      if (request.version !== body.version || request.state !== 'pending' || !['approve', 'reject'].includes(body.choice)) fail(409, 'version_conflict', '权限申请已更新或已经处理');
      if (body.choice === 'approve') {
        const work = request.workId ? this.store.require('collaboration', request.workId) : null;
        const grant = work ? this.store.require('capability_grant', work.grantId) : null;
        if (grant && (grant.state !== 'active' || grant.expiresAt <= this.clock())) fail(409, 'grant_revoked', '原计划授权已失效，需要重新审核计划');
        if (request.capability === 'artifact_read') {
          if (!request.artifactId || !request.revisionId) fail(400, 'invalid_request', '请先选择准确的作品版本');
          if (grant) {
            const participants = [...new Set(['self', ...work.participants.map(item => item.contactId)])];
            if (JSON.stringify([...participants].sort()) !== JSON.stringify([...request.audienceIds].sort())) fail(409, 'source_review_required', '参与者已改变，需要重新审核资料接收范围');
            grant.extraReads.push({ permissionId: request.id, artifactId: request.artifactId, revisionId: request.revisionId, paths: request.paths });
            grant.audienceIds = participants; work.audienceIds = participants; work.audienceBindings = this.audienceBindings(participants); work.privateSources = true;
            this.store.put('capability_grant', grant); this.store.put('collaboration', work);
            const outputLink = this.store.list('artifact_link').find(link => link.threadId === work.threadId && link.artifactId === work.artifactId);
            if (outputLink) this.store.put('artifact_link', { ...outputLink, audienceIds: outputLink.audienceIds.filter(id => participants.includes(id)), version: (outputLink.version || 1) + 1 });
          } else {
            const link = this.share(request.artifactId, { threadId: request.threadId, revisionId: request.revisionId, paths: request.paths }); link.audienceIds = request.audienceIds; this.store.put('artifact_link', link);
          }
        } else if (request.capability === 'artifact_write') {
          const participant = grant?.participants.find(item => item.contactId === request.contactId), step = work?.steps.find(item => item.id === request.stepId);
          if (!participant || request.artifactId !== grant.artifactId || !step || step.contactId !== request.contactId) fail(400, 'invalid_request', '写入扩展必须对应当前计划中的参与者和步骤');
          participant.writePaths = [...new Set([...participant.writePaths, ...request.paths])];
          step.writePaths = [...new Set([...step.writePaths, ...request.paths])];
          this.store.put('capability_grant', grant); this.store.put('collaboration', work);
        } else {
          if (!grant || !work) fail(400, 'invalid_request', '新增伙伴需要一个已经批准的共创计划');
          if (grant.extraReads.length || work.inputs?.sources?.length) fail(409, 'source_review_required', '本轮已使用额外资料；请为新增伙伴重新审核包含全部资料的新计划');
          const contact = this.store.require('contact', request.contactId), thread = this.store.require('thread', work.threadId);
          if (contact.kind !== 'agent' || !['codex', 'pi'].includes(contact.binding?.localAgentId) || contact.version !== request.targetBinding?.version || contact.binding.localAgentId !== request.targetBinding?.localAgentId) fail(409, 'binding_changed', '申请中的伙伴身份或执行器已经改变');
          const base = this.store.require('contact', `agent_${contact.binding.localAgentId}`);
          const participant = { contactId: contact.id, localAgentId: contact.binding.localAgentId, contactSnapshot: { id: contact.id, name: contact.name, handle: contact.handle, description: contact.description, instructions: contact.instructions, version: contact.version }, executionSnapshot: resolveExecution(base.profile, contact.configuration || {}), writePaths: request.paths };
          if (!thread.memberIds.includes(contact.id)) { thread.memberIds.push(contact.id); thread.members.push({ contactId: contact.id, visibleAfterMessageId: thread.messages.at(-1)?.id || null }); thread.version++; this.store.put('thread', thread); }
          if (!grant.participants.some(item => item.contactId === contact.id)) grant.participants.push({ contactId: contact.id, localAgentId: participant.localAgentId, writePaths: request.paths });
          if (!work.participants.some(item => item.contactId === contact.id)) work.participants.push(participant);
          grant.audienceIds = [...new Set([...grant.audienceIds, contact.id])]; work.audienceIds = grant.audienceIds;
          work.audienceBindings = { ...work.audienceBindings, [contact.id]: JSON.stringify(contact.binding) };
          this.store.put('capability_grant', grant); this.store.put('collaboration', work); this.runtime.updateLink(work);
        }
      }
      request.state = body.choice === 'approve' ? 'approved' : 'rejected'; request.version++; request.decidedAt = now(); this.store.put('capability_request', request); return request;
    });
    if (['approved', 'rejected'].includes(result.state) && result.workId) {
      const work = this.store.require('collaboration', result.workId), step = work.steps.find(item => item.id === result.stepId);
      if (step?.status === 'waiting_permission') { work.messages.push({ id: id('handoff'), fromContactId: 'self', toContactId: step.contactId, text: result.state === 'approved' ? '用户已批准这次额外范围，请读取当前授权后继续。' : '用户拒绝了这次额外范围；请在原授权范围内完成替代方案，不要重复申请相同范围。', createdAt: now() }); step.status = 'queued'; step.resumeStageId = step.stageId; work.status = 'queued'; this.store.put('collaboration', work); this.runtime.enqueueNext(work.id); }
    }
    this.notify({ threadId: result.threadId }); return result;
  }
  canPublishConversation(threadId, runId) {
    const thread = this.store.require('thread', threadId), run = thread.runs.find(item => item.id === runId);
    if (!run) return false;
    const source = thread.messages.find(message => message.id === run.messageId);
    const audience = (source?.recipientIds || run.participantSnapshot?.map(peer => peer.id) || thread.memberIds || []).filter(contactId => !thread.memberIds || thread.memberIds.includes(contactId));
    if (run.chatToolReads?.length && !this.options.chatTools?.canReadMessage({ chatToolReads: run.chatToolReads }, audience)) return false;
    if (!run.artifactReads?.length) return true;
    try { return this.readDependenciesAllowed(threadId, run.artifactReads, audience); } catch { return false; }
  }
  inputReferences(thread, messageId) {
    const message = thread.messages.find(item => item.id === messageId);
    return { threadId: thread.id, messageId, requestHash: digest(message.text), sources: (message.attachments || []).map(source => ({ id: source.id, name: source.name, sha256: digest(source.text) })) };
  }
  workInput(work) {
    const refs = work.inputs; if (!refs) return { request: '', sources: [] };
    const message = this.store.require('thread', refs.threadId).messages.find(item => item.id === refs.messageId);
    if (!message || digest(message.text) !== refs.requestHash) fail(409, 'input_changed', '已批准的输入内容已经改变，请重新审核');
    const sources = refs.sources.map(ref => { const source = message.attachments?.find(item => item.id === ref.id); if (!source || source.name !== ref.name || digest(source.text) !== ref.sha256) fail(409, 'input_changed', '已批准的附件已经改变，请重新审核'); return { ...ref, text: source.text }; });
    return { request: message.text, sources };
  }
  revokeSource(threadId, artifactId) {
    for (const work of this.store.list('collaboration').filter(item => item.threadId === threadId && !['completed', 'cancelled'].includes(item.status))) {
      const grant = this.store.require('capability_grant', work.grantId);
      if (work.artifactId === artifactId || grant.extraReads.some(read => read.artifactId === artifactId)) this.runtime.revokeWork(work.id, '来源共享已撤回');
    }
  }
  revokePermission(requestId, body) {
    const request = this.store.idempotent(`permission-revoke:${requestId}`, body.clientId, body, () => {
      const request = this.store.require('capability_request', requestId);
      if (request.version !== body.version || request.state !== 'approved' || !request.workId) fail(409, 'version_conflict', '授权已经改变，请重新查看');
      this.runtime.revokeWork(request.workId, '所有者撤回这次额外权限'); request.state = 'revoked'; request.version++; this.store.put('capability_request', request); return request;
    }); this.notify({ threadId: request.threadId }); return request;
  }
  reconcileMembership(threadId) {
    const thread = this.store.require('thread', threadId);
    for (const link of this.store.list('artifact_link').filter(item => item.threadId === threadId && item.state === 'active')) {
      const audienceIds = link.audienceIds.filter(contactId => thread.memberIds.includes(contactId) && link.audienceBindings?.[contactId] === JSON.stringify(this.store.get('contact', contactId)?.binding || null));
      if (audienceIds.length !== link.audienceIds.length) this.store.put('artifact_link', { ...link, audienceIds, version: (link.version || 1) + 1 });
    }
    for (const work of this.store.list('collaboration').filter(item => item.threadId === threadId && !['completed', 'cancelled'].includes(item.status))) {
      const grant = this.store.require('capability_grant', work.grantId);
      work.audienceIds = work.audienceIds.filter(contactId => thread.memberIds.includes(contactId) && work.audienceBindings?.[contactId] === JSON.stringify(this.store.get('contact', contactId)?.binding || null)); grant.audienceIds = work.audienceIds;
      for (const participant of grant.participants) {
        const contact = this.store.get('contact', participant.contactId);
        if (thread.memberIds.includes(participant.contactId) && contact?.binding?.localAgentId === participant.localAgentId) continue;
        if (!grant.revokedContacts.includes(participant.contactId)) grant.revokedContacts.push(participant.contactId);
        for (const step of work.steps.filter(item => item.contactId === participant.contactId && item.status !== 'completed')) {
          step.status = 'cancelled'; step.error = '参与者已移除或绑定改变';
          for (const runId of step.runIds) this.options.cancelRun?.(threadId, runId);
        }
        for (const contribution of this.store.list('artifact_contribution').filter(item => item.contactId === participant.contactId && item.state === 'submitted' && work.steps.some(step => step.runIds.includes(item.runId)))) this.store.put('artifact_contribution', { ...contribution, state: 'quarantined' });
      }
      this.store.put('capability_grant', grant); this.store.put('collaboration', work);
    }
    this.notify({ threadId });
  }
  forThread(threadId) {
    const thread = this.store.require('thread', threadId);
    return { proposals: this.store.listForThread('creation_proposal', threadId).map(proposal => {
      const base = { id: proposal.id, messageId: proposal.messageId, version: proposal.version };
      if (!proposal.contributors.every(item => this.cardAllowed(threadId, this.contributorRun(proposal, item), thread.memberIds))) return { ...base, title: '方案内容已收回', goal: '群成员或来源权限已改变，请重新共享并讨论。', state: 'restricted', kind: 'document', artifactId: null, baseRevisionId: null, audienceIds: [], sourceNames: [], readPaths: [], publishPaths: [], participants: [], contributors: [] };
      return { ...base, title: proposal.title, kind: proposal.kind, goal: proposal.goal, artifactId: proposal.artifactId, baseRevisionId: proposal.baseRevisionId, state: proposal.state, error: proposal.error, workId: proposal.workId, audienceIds: proposal.audienceIds, sourceNames: proposal.sourceNames, readPaths: proposal.readPaths, publishPaths: proposal.publishPaths,
        participants: proposal.participants.map(({ contactId, localAgentId, contactSnapshot, executionSnapshot }) => ({ contactId, localAgentId, contactSnapshot: { id: contactId, name: contactSnapshot.name }, executionSnapshot })), contributors: proposal.contributors.map(({ runId: _runId, ...contribution }) => contribution) };
    }), collaborations: this.store.listForThread('collaboration', threadId).map(work => { const visible = work.status === 'completed' && this.canRead({ mode: 'conversation', threadId, audienceIds: thread.memberIds }, work.artifactId, work.finalRevisionId); return ({ id: work.id, threadId, title: visible ? this.store.require('workspace_artifact', work.artifactId).title : '共同作品', artifactId: visible ? work.artifactId : null, status: work.status, finalRevisionId: visible ? work.finalRevisionId : undefined, steps: work.steps.map(step => ({ id: step.id, contactId: step.contactId, status: step.status, submittedRevisionId: step.submittedRevisionId ? 'saved' : undefined, task: '共创步骤' })), finalChecks: work.finalChecks ? { passed: work.finalChecks.passed, errors: [], scope: work.finalChecks.scope } : undefined, previewChecks: work.previewChecks ? { passed: work.previewChecks.passed, errors: [] } : undefined }); }),
      links: this.store.listForThread('artifact_link', threadId).filter(item => item.state === 'active' && this.canRead({ mode: 'conversation', threadId, audienceIds: thread.memberIds }, item.artifactId, item.revisionId)),
      permissionRequests: this.store.listForThread('capability_request', threadId).map(({ id, capability, state, version, requestedBy, contactId, workId }) => ({ id, capability, state, version, requestedBy, contactId, workId, reason: '', paths: [], audienceIds: [] })),
      toolActivity: this.store.listForThread('artifact_tool_receipt', threadId, 100) };
  }
  async close() { await this.runtime.close(); }
}
