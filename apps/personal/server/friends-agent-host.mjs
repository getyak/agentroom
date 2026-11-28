import { randomBytes, randomUUID } from 'node:crypto';
import { APIError } from './store.mjs';
import { friendGroupID } from './friends-groups.mjs';
import { createPlayExecutor } from './play-executor.mjs';
import { codexAuthSource } from './codex-isolation.mjs';

const bindings = 'friend_group_binding';
const invalid = () => new APIError(400, 'invalid_group_agent', '请选择自己已添加的本机 Codex');
const revoked = () => new APIError(403, 'group_agent_revoked', '此群的本机 Agent 授权已撤销');
const outputText = result => typeof result?.markdown === 'string' ? result.markdown.trim().slice(0, 12000) : '';
const flags = { add: ['groupId', 'contactId'], remove: ['groupId', 'agentId'], list: ['groupId'] };

export class FriendsAgentHost {
  constructor(store, friends, messenger, deps) {
    this.store = store;
    this.friends = friends;
    this.messenger = messenger;
    this.deps = deps;
    this.stop = new AbortController();
    this.executor = createPlayExecutor(store, {
      deps, folder: 'friends-group-work', directoryPattern: friendGroupID,
      authorize: job => this.authorize(job.roomId, job.agentId),
    });
  }

  rows(groupId) {
    return this.store.list(bindings).filter(binding => binding.origin === this.friends.origin && (!groupId || binding.groupId === groupId));
  }

  authorize(groupId, agentId) {
    const binding = this.store.get(bindings, agentId);
    if (!binding?.active || binding.groupId !== groupId || binding.origin !== this.friends.origin) throw revoked();
    const local = this.store.get('contact', binding.contactId);
    if (!local || local.kind !== 'agent' || local.binding?.type !== 'local' || local.binding.localAgentId !== 'codex' ||
      local.discovered && local.added === false) throw invalid();
    const resolved = this.messenger.publicContact(local);
    if (resolved.availability !== 'ready' || resolved.execution?.provider !== 'openai' || resolved.profile?.guestCompatible === false) {
      throw new APIError(409, 'group_codex_unavailable', '此群需要当前 Mac 可执行的隔离 Codex，未切换账号');
    }
    return resolved;
  }

  async act(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.action !== 'string' ||
      !Object.hasOwn(flags, input.action) || typeof input.groupId !== 'string' || !friendGroupID.test(input.groupId) ||
      Object.keys(input).some(key => key !== 'action' && !flags[input.action].includes(key))) throw invalid();
    const { groupId } = input;
    if (!this.friends.origin) throw new APIError(503, 'friends_not_configured', '此工作区尚未配置好友服务');
    if (input.action === 'list') return { bindings: this.rows(groupId).filter(binding => binding.active || binding.pendingRemove)
      .map(({ id, contactId, pendingRemove }) => ({ agentId: id, contactId, pendingRemove: Boolean(pendingRemove) })) };

    if (input.action === 'remove') {
      const binding = this.store.get(bindings, input.agentId);
      if (!binding || binding.groupId !== groupId || binding.origin !== this.friends.origin) throw revoked();
      this.disable(binding);
      await this.notifyRemoval(binding);
      return { agentId: binding.id };
    }

    if (typeof input.contactId !== 'string' || input.contactId.length > 160) throw invalid();
    const contact = this.store.get('contact', input.contactId);
    if (!contact || contact.kind !== 'agent' || contact.binding?.type !== 'local' || contact.binding.localAgentId !== 'codex' ||
      contact.discovered && contact.added === false) throw invalid();
    const local = this.messenger.publicContact(contact);
    if (local.availability !== 'ready' || local.execution?.provider !== 'openai' || local.profile?.guestCompatible === false) {
      throw new APIError(409, 'group_codex_unavailable', '请先配置本机默认 OpenAI Codex 与文件认证');
    }
    try { await codexAuthSource(this.deps); }
    catch { throw new APIError(409, 'group_codex_unavailable', '无法建立本机 Codex 的隔离认证'); }
    let binding = this.rows(groupId).find(item => item.contactId === contact.id);
    if (binding?.pendingRemove) throw new APIError(409, 'group_codex_removing', '此群的共享撤销仍在同步');
    if (!binding) {
      binding = { id: randomUUID(), groupId, contactId: contact.id, name: local.name.slice(0, 64), origin: this.friends.origin, active: false };
      this.store.put(bindings, binding);
    }
    await this.friends.act({ action: 'group-agent-add', groupId, agentId: binding.id, name: binding.name });
    const current = this.store.get(bindings, binding.id);
    if (!current || current.pendingRemove) throw revoked();
    this.store.put(bindings, { ...binding, active: true });
    this.kick();
    return { agentId: binding.id };
  }

  disable(binding) {
    this.store.put(bindings, { ...binding, active: false, pendingRemove: true });
    if (this.running?.agentId === binding.id) this.running.controller.abort();
  }

  leaveGroup(groupId) {
    if (!friendGroupID.test(groupId)) throw invalid();
    for (const binding of this.rows(groupId)) this.disable(binding);
    this.kick();
  }

  async notifyRemoval(binding) {
    try { await this.friends.act({ action: 'group-agent-remove', groupId: binding.groupId, agentId: binding.id }, this.stop.signal); }
    catch (error) { if (!(error instanceof APIError) || error.status !== 403) throw error; }
    this.store.delete(bindings, binding.id);
  }

  start() {
    this.timer = setInterval(() => this.kick(), 2500);
    this.timer.unref();
  }

  kick() {
    if (this.task || this.suspended || this.stop.signal.aborted || !this.friends.origin ||
      !this.rows().some(binding => binding.active || binding.pendingRemove)) return;
    this.task = this.tick().catch(() => {}).finally(() => { this.task = null; });
  }

  async tick() {
    for (const binding of this.rows().filter(binding => binding.pendingRemove)) await this.notifyRemoval(binding);
    if (!this.rows().some(binding => binding.active)) return;
    const { jobs } = await this.friends.call({ action: 'group-work' }, this.stop.signal);
    if (!Array.isArray(jobs) || this.suspended || this.stop.signal.aborted) return;
    const available = new Set(this.rows().filter(row => row.active).map(row => row.id));
    const job = jobs.find(item => item && available.has(item.agentId));
    if (!job) return;
    const claim = randomBytes(32).toString('base64url');
    const controller = new AbortController();
    this.running = { agentId: job.agentId, controller };
    const signal = AbortSignal.any([this.stop.signal, controller.signal]);
    try {
      const { context } = await this.friends.call({ action: 'group-claim', jobId: job.id, claim }, signal);
      let text = '';
      try {
        const local = this.authorize(job.groupId, job.agentId);
        text = outputText(await this.executor.execute(context, signal, {
          id: job.id, roomId: job.groupId, agentId: job.agentId, backend: 'codex', executionSnapshot: local.execution,
        }));
      } catch { /* Failed work is recorded without leaking CLI errors into the room. */ }
      const answer = { action: 'group-finish', jobId: job.id, claim, text, failed: !text };
      if (!signal.aborted) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try { await this.friends.call(answer, signal); break; }
          catch (error) { if (signal.aborted || error.status !== 503) break; }
        }
      }
    } finally { this.running = null; }
  }

  async close() {
    clearInterval(this.timer);
    this.stop.abort();
    await this.task;
    await this.executor.close();
  }
}
