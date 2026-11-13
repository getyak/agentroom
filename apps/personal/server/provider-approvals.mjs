// Only the owning desktop utility registers sources. No renderer-controlled
// endpoint, credential, raw provider option or arbitrary RPC enters this inbox.
import { APIError, connectionIdentity, digest, id, now } from './store.mjs';
import { rpc } from './runtime.mjs';
const sameIdentity = (source, connection) => JSON.stringify(source.identity) === JSON.stringify(connectionIdentity(connection));

export class ProviderApprovals {
  constructor(store, messenger, notify, kick, options = {}) {
    Object.assign(this, { store, messenger, notify, kick, options });
    this.closed = false; this.pending = null;
    for (const answer of store.list('provider_answer')) if (answer.state === 'sending') store.put('provider_answer', { ...answer, state: 'unknown' });
  }
  register({ connectionId, instanceId, service }) {
    if (service !== 'grokbot' || !/^[A-Za-z0-9_-]{1,160}$/.test(instanceId)) return;
    const connection = this.store.require('connection', connectionId);
    const url = new URL(connection.url);
    if (connection.type !== 'a2a' || url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== `/a2a/${instanceId}`) throw new Error('Invalid native approval source');
    const source = { id: connectionId, instanceId, identity: connectionIdentity(connection) };
    const prior = this.store.get('native_approval_source', source.id);
    if (prior && !sameIdentity(prior, connection)) throw new Error('Native approval identity changed');
    this.store.put('native_approval_source', source);
  }
  choose(thread, decision, body) {
    if (decision.authority === 'original_app_only') throw new APIError(409, 'original_app_required', '这项权限需要在原应用中处理');
    const source = this.store.require('native_approval_source', decision.providerConnectionId);
    const connection = this.store.require('connection', source.id);
    if (!sameIdentity(source, connection)) throw new APIError(409, 'approval_identity_changed', '连接身份已改变，请重新核查');
    const choice = decision.choices.find(item => item.key === body.choice);
    if (!choice) throw new APIError(400, 'bad_choice', '请选择这张卡片上的原始选项');
    const answer = { id: id('answer'), connectionId: source.id, cardId: decision.providerCardId, revision: decision.providerRevision,
      requestGeneration: decision.providerRequestGeneration || null,
      choice: choice.key, label: choice.label, decisionId: decision.id, threadId: thread.id, state: 'queued' };
    this.store.put('provider_answer', answer);
    decision.state = 'sending'; decision.version++; decision.choiceLabel = choice.label;
    decision.decision = { choice: choice.key, decidedAt: now() }; decision.deliveryState = 'queued';
    thread.updatedAt = now(); return thread;
  }
  async call(connection, method, params) {
    return this.options.call ? this.options.call(connection, method, params) : rpc(connection, method, params, AbortSignal.timeout(15_000), id('approval'), undefined, this.store.vault);
  }
  start() { this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 1500); this.timer.unref(); }
  tick() {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.sync().finally(() => { this.pending = null; }); return this.pending;
  }
  async sync() {
    for (const source of this.store.list('native_approval_source')) {
      if (this.closed) return;
      const connection = this.store.get('connection', source.id);
      if (!connection || !sameIdentity(source, connection)) continue;
      try {
        const result = await this.call(connection, 'agentstudio/approvals/list', {});
        if (!Array.isArray(result?.approvals) || result.approvals.length > 1000) continue;
        for (const card of result.approvals) this.project(source, connection, card);
        for (const answer of this.store.list('provider_answer').filter(item => item.connectionId === source.id && item.state === 'queued')) {
          if (this.closed) return;
          const current = this.store.get('thread', answer.threadId)?.decisions.find(item => item.id === answer.decisionId);
          const observed = result.approvals.find(card => card.id === answer.cardId);
          if (!observed) continue; // Omission is not a cancellation or permission to send.
          // A fresh observation may supersede a queued, still-unsent answer.
          if (!current || observed.originalAppOnly || observed.state !== 'pending' || observed.revision !== answer.revision
            || (observed.requestGeneration || null) !== (answer.requestGeneration || null)
            || current.authority === 'original_app_only' || current.state !== 'sending' || current.providerRevision !== answer.revision) {
            this.store.put('provider_answer', { ...answer, state: 'stale' });
            if (current?.state === 'sending') {
              const thread = this.store.require('thread', answer.threadId), decision = thread.decisions.find(item => item.id === answer.decisionId);
              decision.state = 'cancelled'; decision.version++; decision.deliveryState = 'stale'; this.store.put('thread', thread);
            }
            continue;
          }
          // This transition is durable before any network operation. An interrupted
          // answer is read back on restart; it is never automatically sent twice.
          this.store.put('provider_answer', { ...answer, state: 'sending' });
          let state = 'unknown';
          try { const receipt = await this.call(connection, 'agentstudio/approvals/respond', { id: answer.cardId, revision: answer.revision, choice: answer.choice, requestId: answer.id });
            state = ['accepted', 'stale', 'unknown'].includes(receipt?.state) ? receipt.state : 'unknown';
          } catch { /* Accepted mutations can lose their response. */ }
          this.store.put('provider_answer', { ...answer, state });
          const thread = this.store.get('thread', answer.threadId), decision = thread?.decisions.find(item => item.id === answer.decisionId);
          if (decision && decision.state === 'sending') {
            decision.state = state === 'accepted' ? 'decided' : state === 'stale' ? 'cancelled' : 'unknown'; decision.version++;
            decision.deliveryState = state === 'accepted' ? 'delivered' : state;
            decision.actionState = 'not_observed'; decision.verificationState = 'not_provided';
            decision.providerSource = 'agentroom'; this.store.put('thread', thread); this.notify({ threadId: thread.id });
          }
        }
      } catch { /* Offline/omitted cards are not cancelled or treated as answered. */ }
    }
  }
  project(source, connection, card) {
    if (!card || typeof card.id !== 'string' || card.id.length > 200 || typeof card.revision !== 'string' || card.revision.length > 200 || typeof card.title !== 'string' || card.title.length > 30000 || !['pending', 'resolved'].includes(card.state) || !Array.isArray(card.choices) || card.choices.length > 32 || card.choices.some(choice => typeof choice.key !== 'string' || choice.key.length > 200 || typeof choice.label !== 'string' || choice.label.length > 1000)) return;
    if (card.requestGeneration !== undefined && (typeof card.requestGeneration !== 'string' || !card.requestGeneration || card.requestGeneration.length > 200)) return;
    const generation = card.requestGeneration || null;
    const baseId = `pdec_${digest(`${source.id}:${card.id}`).slice(0, 40)}`;
    const history = this.store.list('thread').flatMap(thread => thread.decisions.filter(decision => decision.providerConnectionId === source.id && decision.providerCardId === card.id).map(decision => ({ thread, decision })));
    // Upgrade only an exact legacy observation, never infer equivalence from a
    // reused provider card ID. Ambiguous history keeps its original record.
    const existing = history.find(item => (item.decision.providerRequestGeneration || null) === generation)
      || history.find(item => !item.decision.providerRequestGeneration && item.decision.providerRevision === card.revision);
    const decisionId = existing?.decision.id || (history.length ? `pdec_${digest(`${source.id}:${card.id}:${generation}`).slice(0, 40)}` : baseId);
    let thread = existing?.thread;
    if (!thread && card.replyTo) thread = this.store.list('thread').find(item => item.runs.some(run => run.id === card.replyTo && run.connectionId === source.id));
    if (!thread) {
      if (card.state !== 'pending') return; // do not import historic answered cards
      this.messenger.sync({ agents: [] });
      thread = this.messenger.createChat({ kind: 'direct', memberIds: [`connection_${source.id}`] });
    }
    const prior = thread.decisions.find(item => item.id === decisionId);
    const answers = this.store.list('provider_answer');
    if (existing && generation) for (const answer of answers) if (answer.decisionId === decisionId && !answer.requestGeneration && answer.revision === card.revision) {
      answer.requestGeneration = generation; this.store.put('provider_answer', answer);
    }
    let answer = answers.find(item => item.decisionId === decisionId && item.state !== 'stale');
    if (answer && answer.state !== 'accepted' && card.deliveryState === 'accepted' && card.responseRequestId === answer.id) {
      answer = { ...answer, state: 'accepted' }; this.store.put('provider_answer', answer);
    }
    if (answer?.state === 'queued' && (card.state === 'resolved' || answer.revision !== card.revision)) {
      this.store.put('provider_answer', { ...answer, state: 'stale' }); answer = null;
    }
    const uncertainPrior = answers.some(item => item.connectionId === source.id && item.cardId === card.id && item.decisionId !== decisionId && ['queued','sending','unknown'].includes(item.state));
    const state = card.state === 'resolved' ? 'decided' : answer ? answer.state === 'accepted' ? 'decided' : ['queued','sending'].includes(answer.state) ? 'sending' : 'unknown' : uncertainPrior || ['sending','unknown','accepted'].includes(card.deliveryState) ? 'unknown' : 'pending';
    const boundRunId = prior?.runId || card.replyTo;
    const run = boundRunId ? thread.runs.find(item => item.id === boundRunId && item.connectionId === source.id) : null;
    const projection = { kind: 'provider_approval', requestType: 'choice', authority: card.originalAppOnly ? 'original_app_only' : 'provider',
      id: decisionId, providerConnectionId: source.id, providerCardId: card.id, providerRevision: card.revision, providerRequestGeneration: generation,
      ...(run ? { runId: run.id } : {}), title: card.title, summary: card.originalAppOnly ? '请在 Grok Bot 中核对本机权限。处理结果会自动同步到这里。' : 'Grok Bot 的原始确认卡。仅将你选择的选项回传给这张卡。',
      preview: JSON.stringify({ service: connection.name, prompt: card.title, options: card.choices.map(item => item.label) }, null, 2), choices: card.choices,
      state, choiceLabel: card.choiceLabel || answer?.label || null, providerSource: card.source || (answer ? 'agentroom' : null),
      deliveryState: answer?.state === 'accepted' ? 'delivered' : answer?.state || (card.state === 'resolved' ? 'not_required' : card.deliveryState || 'not_sent'),
      actionState: 'not_observed', verificationState: 'not_provided',
      decision: answer ? { choice: answer.choice, decidedAt: prior?.decision?.decidedAt || now() } : null };
    const previous = prior && Object.fromEntries(Object.entries(prior).filter(([key]) => !['version','createdAt'].includes(key)));
    if (JSON.stringify(previous) !== JSON.stringify(projection)) {
      const decision = { ...projection, version: (prior?.version || 0) + 1, createdAt: prior?.createdAt || now() };
      if (prior) thread.decisions[thread.decisions.indexOf(prior)] = decision; else {
        for (const previous of history) if (previous.decision.state === 'pending') {
          const record = previous.thread.id === thread.id ? thread.decisions.find(item => item.id === previous.decision.id) : previous.decision;
          record.state = 'cancelled'; record.version++;
          if (previous.thread.id !== thread.id) this.store.put('thread', previous.thread);
        }
        thread.decisions.push(decision);
      }
      thread.updatedAt = now(); this.store.put('thread', thread); this.notify({ threadId: thread.id });
    }
    if (!prior && run && run.status === 'completed') {
      run.status = 'blocked'; run.remoteStatus = 'input-required'; run.requiresReconciliation = true; run.phase = 'reconcile';
      thread.status = 'blocked'; thread.summary = '原任务又收到一项审批，正在核查接续状态'; this.store.put('thread', thread); this.notify({ threadId: thread.id });
    }
    if (card.state === 'resolved' && run && run.externalTaskId && ['blocked','unknown'].includes(run.status) && !run.stopUnconfirmed && !thread.decisions.some(item => item.kind === 'provider_approval' && item.runId === run.id && ['pending','sending','unknown'].includes(item.state))) {
      run.status = 'queued'; run.phase = 'reconcile'; run.requiresReconciliation = false; run.error = null;
      thread.status = 'queued'; thread.summary = '审批已处理，正在查询原任务的后续结果'; this.store.put('thread', thread); this.kick(); this.notify({ threadId: thread.id });
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.pending; }
}
