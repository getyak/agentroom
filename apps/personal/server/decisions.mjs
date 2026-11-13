import { APIError, connectionIdentity, digest, id, now } from './store.mjs';
import { decisionThread, decisionView } from './decision-views.mjs';

export const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
export const connectionBinding = connection => ({ ...connectionIdentity(connection), sessionId: connection.sessionId || null, protocolVersion: connection.protocolVersion || null });
const fail = (code, message, status = 409) => { throw new APIError(status, code, message); };
const payloadHash = payload => digest(canonical(payload));
const audience = run => (run.participantMemberships || []).map(member => ({ contactId: member.contactId, membershipId: member.membershipId })).sort((a,b) => a.contactId.localeCompare(b.contactId));

// This module owns decision mutation and dispatch admission. The executor seam
// is handed only to the existing worker by the workspace assembler, never IPC.
export class Decisions {
  constructor(store, options = {}) {
    this.store = store; this.options = options; this.clock = options.clock || Date.now;
    this.executor = Object.freeze({
      claim: (threadId, runId, schemaFingerprint, catalogBinding) => this.claim(threadId, runId, schemaFingerprint, catalogBinding),
      observe: (thread, run) => this.observe(thread, run),
    });
    for (const attempt of store.list('decision_attempt')) if (attempt.state === 'claimed') store.put('decision_attempt', { ...attempt, state: 'unknown' });
  }

  request(threadId, runId, spec) {
    const result = this.store.transaction(() => {
      const thread = this.store.require('thread', threadId), run = thread.runs.find(item => item.id === runId);
      const fingerprint = payloadHash(spec.payload);
      const prior = thread.decisions.find(item => item.runId === runId && item.kind !== 'provider_approval');
      if (prior) {
        if (payloadHash(prior.payload) !== fingerprint || prior.schemaFingerprint !== spec.schemaFingerprint || prior.operationType !== spec.operationType) fail('effect_changed', '原操作内容已经固定，不能替换为另一项操作');
        return prior;
      }
      if (!run || !['running','queued'].includes(run.status)) fail('inactive_decision', '原运行当前无法准备操作');
      const connection = this.store.require('connection', run.connectionId);
      if (!['mcp','a2a'].includes(spec.operationType) || connection.type !== spec.operationType) fail('invalid_effect', '操作与已接受的执行连接不一致');
      const identity = connectionBinding(connection);
      if (spec.preparedBinding && canonical(spec.preparedBinding) !== canonical(identity)) fail('approval_identity_changed', '准备操作时的工具目录不属于当前连接身份');
      const scopeFingerprint = digest(canonical({ threadId, contactId: run.contactId || null, audience: audience(run),
        operationType: spec.operationType, payload: spec.payload, identity, schemaFingerprint: spec.schemaFingerprint || null }));
      const grant = spec.operationType === 'mcp' && spec.schemaFingerprint ? this.store.list('decision_grant').find(item =>
        item.scopeFingerprint === scopeFingerprint && item.state === 'active' && item.expiresAt > this.clock() && item.used < item.maxUses) : null;
      const decision = { id: id('dec'), runId, version: 1, requestType: 'authorization', authority: 'agentroom', operationType: spec.operationType,
        title: spec.title, summary: spec.summary, preview: spec.preview, payload: structuredClone(spec.payload), endpoint: connection.url,
        identity: { label: connection.name, authentication: connection.credentialRef ? 'bearer' : 'none', identityVerified: false },
        ...(spec.schemaFingerprint ? { schemaFingerprint: spec.schemaFingerprint } : {}),
        choices: [{ key: 'approve', label: spec.operationType === 'mcp' ? '允许这次调用' : '发送这次内容' }, { key: 'reject', label: '不执行' }],
        state: grant ? 'decided' : 'pending', decision: grant ? { choice: 'approve', decidedAt: now(), basis: 'grant' } : null,
        ...(grant ? { grantId: grant.id } : {}), deliveryState: 'not_sent', actionState: 'not_started', verificationState: 'not_started', createdAt: now() };
      this.store.put('decision_identity', { id: decision.id, ...connectionIdentity(connection), binding: identity,
        payloadHash: fingerprint, scopeFingerprint, schemaFingerprint: spec.schemaFingerprint || null });
      thread.decisions.push(decision); run.status = grant ? 'running' : 'needs_input'; run.phase = 'prepare';
      thread.status = run.status; thread.summary = grant ? '沿用已明确授权的相同操作' : spec.summary; thread.updatedAt = now();
      this.store.event(thread, grant ? 'decision' : 'needs_input', thread.summary, { runId, decisionId: decision.id });
      this.store.refreshThread(thread);
      this.store.put('thread', thread); return decision;
    });
    this.options.notify?.({ threadId }); return decisionView(this.store, result, this.clock);
  }

  respond(decisionId, command, actor) {
    if (actor?.type !== 'owner') fail('not_approver', '只有本工作区的本人入口可以处理这项决定', 403);
    const result = this.store.idempotent(`decisions:${decisionId}`, command.clientId, command, () => {
      const thread = this.store.list('thread').find(item => item.decisions.some(decision => decision.id === decisionId));
      if (!thread) fail('not_found', '找不到这条确认', 404);
      const decision = thread.decisions.find(item => item.id === decisionId);
      if (decision.version !== command.version) fail('version_conflict', '确认卡已更新，请刷新后操作');
      if (command.action === 'revoke') {
        if (decision.kind === 'provider_approval' || !decision.grantId) fail('grant_not_found', '这项请求没有可撤销的持续授权');
        const grant = this.store.require('decision_grant', decision.grantId);
        if (grant.threadId !== thread.id) fail('grant_not_found', '授权不属于当前对话');
        this.store.put('decision_grant', { ...grant, state: 'revoked', authorityEpoch: grant.authorityEpoch + 1, revokedAt: now() });
        decision.version++;
        // Claim is the consumption point. Never call a claimed remote effect cancelled.
        for (const run of thread.runs) if (thread.decisions.some(item => item.runId === run.id && item.grantId === grant.id)
          && !this.store.get('decision_attempt', run.id) && ['queued','running','needs_input'].includes(run.status)) {
          run.status = 'cancelled'; run.finishedAt = now(); run.error = '后续授权已撤销，这次操作没有派发';
        }
        this.store.refreshThread(thread); thread.updatedAt = now(); return this.store.put('thread', thread);
      }
      if (command.action !== undefined) fail('bad_request', '不支持这个决定操作', 400);
      if (decision.state !== 'pending') fail('already_decided', '这条确认已经处理');
      if (decision.kind === 'provider_approval') {
        if (command.grantDuration && command.grantDuration !== 'once') fail('invalid_grant', '原服务选项不能授予本机持续权限', 400);
        if (!this.options.provider) fail('provider_unavailable', '原服务审批暂不可用');
        return this.store.put('thread', this.options.provider.choose(thread, decision, command));
      }
      if (!['approve','reject'].includes(command.choice)) fail('bad_request', '请选择允许或不执行', 400);
      if (command.grantDuration !== undefined && !['once','conversation_exact'].includes(command.grantDuration)) fail('invalid_grant', '授权范围无效', 400);
      const run = thread.runs.find(item => item.id === decision.runId);
      if (!run || run.status !== 'needs_input') fail('inactive_decision', '任务当前无法接收确认');
      if (command.choice === 'approve') this.assertIdentity(decision, run, thread);
      if (command.grantDuration === 'conversation_exact') {
        const identity = this.store.require('decision_identity', decision.id);
        if (command.choice !== 'approve' || decision.operationType !== 'mcp' || !identity.schemaFingerprint) fail('invalid_grant', '这项操作不支持持续授权', 400);
        const grant = { id: id('grant'), threadId: thread.id, scopeFingerprint: identity.scopeFingerprint,
          state: 'active', authorityEpoch: 1, expiresAt: this.clock() + 3_600_000, maxUses: 10, used: 0, createdAt: now() };
        this.store.put('decision_grant', grant); decision.grantId = grant.id;
      }
      decision.state = 'decided'; decision.version++; decision.decision = { choice: command.choice, decidedAt: now(), basis: 'owner' };
      run.status = command.choice === 'approve' ? 'queued' : 'cancelled';
      if (command.choice === 'reject') run.finishedAt = now();
      thread.status = run.status; thread.summary = command.choice === 'approve' ? '决定已记录，等待发送；尚未执行' : '这次操作没有执行';
      this.store.event(thread, 'decision', thread.summary, { runId: run.id, decisionId });
      this.store.refreshThread(thread); thread.updatedAt = now(); return this.store.put('thread', thread);
    });
    this.options.notify?.({ threadId: result.id }); this.options.kick?.();
    return decisionThread(this.store, result, this.clock);
  }

  read(query = {}) {
    const values = this.options.messenger ? this.options.messenger.approvals() : this.store.list('thread').flatMap(thread => thread.decisions.map(decision => ({ ...decision, threadId: thread.id, threadTitle: thread.title })));
    return values.filter(decision => !query.threadId || decision.threadId === query.threadId).map(decision => decisionView(this.store, decision, this.clock));
  }

  assertIdentity(decision, run, thread) {
    const connection = this.store.require('connection', run.connectionId), stored = this.store.get('decision_identity', decision.id);
    const matches = stored?.binding ? canonical(stored.binding) === canonical(connectionBinding(connection))
      : stored ? stored.connectionId === connection.id && stored.url === connection.url
        && stored.credentialRef === (connection.credentialRef || null) && stored.credentialVersion === (connection.credentialVersion || 0)
      : !connection.credentialRef && !decision.operationType;
    if (!matches) fail('approval_identity_changed', '连接目标或凭据身份已改变，请重新核对');
    if (Array.isArray(run.participantMemberships) && Array.isArray(thread.members)
      && canonical(audience(run)) !== canonical(audience({ participantMemberships: thread.members }))) fail('approval_identity_changed', '原对话的完整参与范围已经改变');
    if (run.contactId && thread.memberIds && !thread.memberIds.includes(run.contactId)) fail('approval_identity_changed', '执行者已离开原对话');
    for (const accepted of run.participantMemberships || []) {
      if (thread.members && thread.members.find(member => member.contactId === accepted.contactId)?.membershipId !== accepted.membershipId) fail('approval_identity_changed', '原对话的参与身份已经改变');
    }
    const contact = run.contactId ? this.store.get('contact', run.contactId) : null;
    if (this.store.get('mcp_request', run.id)) {
      if (!this.options.assertMCPRequest?.(thread, run)) fail('approval_identity_changed', '本机 Agent 的工具申请缺少有效授权证据');
    } else if (contact && (contact.binding?.type !== 'connection' || contact.binding.connectionId !== run.connectionId)) fail('approval_identity_changed', '联系人已更换执行连接');
    return { connection, stored };
  }

  claim(threadId, runId, schemaFingerprint, catalogBinding) {
    return this.store.transaction(() => {
      const thread = this.store.require('thread', threadId), run = thread.runs.find(item => item.id === runId);
      if (this.store.get('decision_attempt', runId) || ['sending','delivered','unknown'].includes(run?.deliveryState)) fail('unknown_execution', '已经派发或结果不明的操作不能再次提交');
      const decision = thread.decisions.find(item => item.runId === runId && item.kind !== 'provider_approval');
      if (!decision || decision.state !== 'decided' || decision.decision?.choice !== 'approve') fail('not_approved', '没有这次操作的有效授权');
      const grant = decision.grantId ? this.store.require('decision_grant', decision.grantId) : null;
      if (grant?.state === 'revoked') fail('grant_revoked', '这项持续授权已经撤销');
      if (grant && grant.expiresAt <= this.clock()) fail('grant_expired', '这项持续授权已经到期');
      if (grant && grant.used >= grant.maxUses) fail('grant_exhausted', '这项持续授权的次数已用完');
      if (!run || !['running','queued'].includes(run.status)) fail('inactive_decision', '原运行当前不能派发操作');
      const { connection, stored } = this.assertIdentity(decision, run, thread);
      if (catalogBinding && canonical(catalogBinding) !== canonical(connectionBinding(connection))) fail('approval_identity_changed', '工具目录来自另一连接身份或会话');
      if (grant && (grant.threadId !== threadId || grant.scopeFingerprint !== stored?.scopeFingerprint)) fail('grant_scope_changed', '这份授权不覆盖当前操作和对话');
      if (stored?.payloadHash && stored.payloadHash !== payloadHash(decision.payload)) fail('effect_changed', '已批准的操作内容发生变化');
      if (stored?.schemaFingerprint && stored.schemaFingerprint !== schemaFingerprint) fail('tool_contract_changed', '工具声明已改变，旧批准不再适用');
      this.store.vault.authorization(connection);
      if (grant) this.store.put('decision_grant', { ...grant, used: grant.used + 1 });
      this.store.put('decision_attempt', { id: runId, threadId, runId, decisionId: decision.id, state: 'claimed',
        payloadHash: payloadHash(decision.payload), ...(grant ? { grantId: grant.id, authorityEpoch: grant.authorityEpoch } : {}), createdAt: now() });
      run.status = 'running'; run.deliveryState = 'sending'; run.actionState = 'running'; run.phase = 'dispatch';
      decision.deliveryState = 'sending'; decision.actionState = 'running'; this.store.put('thread', thread);
      return { operationId: runId, payload: structuredClone(decision.payload) };
    });
  }

  observe(thread, run) {
    const decision = thread.decisions.find(item => item.runId === run.id && item.kind !== 'provider_approval' && item.state === 'decided');
    if (!decision) return;
    for (const field of ['deliveryState','actionState','verificationState']) if (run[field] !== undefined) decision[field] = run[field];
    decision.verificationScope = run.externalVerification?.scope || run.verification?.scope || null;
    decision.localArtifactVerification = run.verification?.scope === 'local_artifact_readback' ? 'verified' : 'not_provided';
    const attempt = this.store.get('decision_attempt', run.id);
    if (attempt) this.store.put('decision_attempt', { ...attempt, state: ['completed','failed'].includes(run.actionState) ? run.actionState : run.deliveryState === 'unknown' ? 'unknown' : attempt.state,
      deliveryState: run.deliveryState, actionState: run.actionState, verificationState: run.verificationState });
  }
}
