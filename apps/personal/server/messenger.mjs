import { defaultAgentAvatar, normalizeAgentAvatar, agentAvatarActivity } from './agent-avatar.mjs';
import { nodePresence } from './remote-nodes.mjs';
import { validateConfiguration, resolveExecution } from './agent-profiles.mjs';
import { APIError, id, now } from './store.mjs';
import { imSettings, addReaction, REACTIONS } from './im-participation.mjs';
import { validateGroupAvatar } from './group-avatar.mjs';
import { nativeSource } from './native-services.mjs';

const SELF = 'self';
const policies = ['auto', 'mention', 'always', 'manual'];
const icons = ['auto', 'spark', 'code', 'research', 'write', 'compass', 'brain', 'person'];
const colors = ['blue', 'violet', 'teal', 'orange', 'rose'];
const fail = (message, status = 400, code = 'bad_request') => { throw new APIError(status, code, message); };
const text = (value, max, fallback = '') => {
  if (value == null) return fallback;
  if (typeof value !== 'string' || value.length > max) fail(`请输入 ${max} 字以内的文本`);
  return value.trim();
};
const identity = contact => ({ id: contact.id, kind: contact.kind, name: contact.name, handle: contact.handle, discovered: Boolean(contact.discovered),
  ...(contact.systemRole === 'guide' ? { systemRole: 'guide' } : {}),
  description: contact.description, instructions: contact.instructions, color: contact.color, icon: contact.icon || 'auto', ...(contact.kind === 'agent' ? { avatar: contact.avatar === undefined ? (!contact.discovered && !contact.avatarDataUrl && !contact.avatarService && (!contact.icon || contact.icon === 'auto') ? defaultAgentAvatar(contact) : null) : contact.avatar } : {}), avatarAgent: contact.binding?.type === 'local' ? contact.binding.localAgentId : null, version: contact.version });

/** Personal, single-owner address book. Discovery updates capability facts, never a user's identity. */
export class Messenger {
  constructor(store, options = {}) {
    this.store = store; this.options = options;
    if (!store.get('contact', SELF)) store.put('contact', { id: SELF, kind: 'human', name: '你', handle: 'you',
      description: '这台 Mac 的使用者', instructions: '', color: 'blue', version: 1, availability: 'self', createdAt: now() });
  }

  sync(detected) {
    for (const agent of detected.agents) {
      const contactId = `agent_${agent.id}`, previous = this.store.get('contact', contactId);
      this.putDiscovered({ id: contactId, kind: 'agent', name: agent.name, handle: agent.id,
        description: '这台 Mac 上的助手', instructions: '', color: agent.id === 'codex' ? 'blue' : 'violet',
        version: 1, createdAt: now(), ...previous, added: previous ? previous.added !== false : false, discovered: true, binding: { type: 'local', localAgentId: agent.id },
        availability: !agent.installed ? 'not_installed' : !agent.execution.supported ? 'unsupported' : agent.auth.status === 'configured' ? 'ready' : 'login_required',
        profile: agent.profile || null, availabilityReason: agent.execution.reason || '', providerName: agent.name });
    }
    for (const connection of this.store.list('connection')) {
      const contactId = `connection_${connection.id}`, previous = this.store.get('contact', contactId);
      const handle = `remote-${connection.id.replace(/[^a-z0-9]/gi, '').slice(-12).toLowerCase()}`;
      this.putDiscovered({ id: contactId, kind: 'agent', name: connection.name, handle,
        description: connection.node ? `${connection.node.name} 上的助手` : connection.type === 'mcp' ? '已连接的工具助手' : '已连接的个人 Agent', instructions: '', color: 'teal',
        version: 1, createdAt: now(), ...previous, discovered: true,
        binding: { type: 'connection', connectionId: connection.id }, availability: 'ready', providerName: connection.name });
    }
    this.options.onSync?.(detected);
    return this.contacts();
  }

  putDiscovered(value) { const previous = this.store.get('contact', value.id); if (JSON.stringify(previous) !== JSON.stringify(value)) this.store.put('contact', value); }

  publicContact(contact) {
    const binding = contact.binding;
    const connection = binding?.type === 'connection' ? this.store.get('connection', binding.connectionId) : null;
    const native = connection && nativeSource(this.store, connection);
    const chatBinding = connection?.type === 'mcp' ? contact.chatBackend : binding;
    const base = chatBinding?.type === 'local' ? this.store.get('contact', `agent_${chatBinding.localAgentId}`) : null;
    let execution = null, configurationError = '';
    const profile = base?.profile || (contact.discovered ? contact.profile : null);
    if (connection?.type === 'mcp' && !chatBinding) configurationError = '请在联系人设置中明确选择聊天助手，工具连接本身没有对话模型';
    if (contact.kind === 'agent' && chatBinding?.type === 'local' && profile) { try { execution = resolveExecution(profile, contact.configuration || {}); } catch (error) { configurationError = error.message; } }
    const node = connection?.node ? this.store.get('remote_node', connection.node.id) : null;
    const observed = node?.agents.find(agent => agent.id === connection.node.agentId);
    const threads = this.store.list('thread');
    const runs = threads.flatMap(thread => thread.runs).filter(run => run.contactId === contact.id);
    let presence = contact.kind !== 'agent' ? null : node ? { ...nodePresence(node), ...(observed?.activity || {}) }
      : chatBinding?.type === 'local' ? { state: (base?.availability || contact.availability) === 'ready' ? 'online' : 'attention', deviceName: '这台 Mac',
        running: runs.filter(run => ['running', 'verifying'].includes(run.status)).length, waiting: runs.filter(run => run.status === 'needs_input').length, lastSeenAt: null }
      : native ? { state: native.status === 'ready' ? 'online' : 'attention', deviceName: '这台 Mac', reason: native.status === 'ready' ? '' : '原服务连接未恢复', lastSeenAt: null }
      : { state: connection ? 'unknown' : 'offline', deviceName: '', lastSeenAt: null };
    let remoteAvailability = null;
    if (node) {
      if (!observed) remoteAvailability = 'disconnected';
      else if (presence.state !== 'online') remoteAvailability = 'disconnected';
      else if (observed.availability === 'login_required') remoteAvailability = 'login_required';
      else if (observed.availability === 'not_installed') remoteAvailability = 'not_installed';
      else if (observed.availability !== 'configured') remoteAvailability = 'unsupported';
      if (remoteAvailability && presence.state === 'online') presence = { ...presence, state: 'attention', reason: !observed ? '来源设备已停止共享这位联系人' : observed.availability === 'unsupported' ? '这位伙伴暂时只能在来源设备中聊天' : '需要在来源设备检查登录或配置' };
    }
    const avatarActivity = contact.kind === 'agent' ? agentAvatarActivity(runs,
      threads.flatMap(t => t.decisions.filter(d => d.runId ? runs.some(r => r.id === d.runId) : binding?.type === 'connection' && d.providerConnectionId === binding.connectionId && t.memberIds?.includes(contact.id))),
      node && presence.state === 'online' ? observed?.activity : undefined) : undefined;
    return { ...contact, avatarActivity, presence, ...(native?.service ? { avatarService: native.service } : {}), ...(native?.avatarDataUrl ? { avatarDataUrl: native.avatarDataUrl } : {}), connectionType: connection?.type || null, profile, execution, configurationError, ...(contact.kind === 'human' ? { availability: contact.id === SELF ? 'self' : 'local_only' }
      : configurationError ? { availability: 'configuration_required', providerName: connection?.name || base?.providerName || '' }
      : chatBinding?.type === 'local' ? { availability: base?.availability || 'not_installed', providerName: connection?.name || base?.providerName || chatBinding.localAgentId }
        : { availability: remoteAvailability || (native && native.status !== 'ready' ? native.status === 'needs_login' ? 'login_required' : 'disconnected' : connection ? 'ready' : 'disconnected'), providerName: connection?.name || '连接已移除' }) };
  }
  contacts() { return this.store.list('contact').map(c => this.publicContact(c)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')); }

  addLocalAgents(body, detected) {
    if (!Array.isArray(body.agentIds) || !body.agentIds.length || body.agentIds.length > 5
      || body.agentIds.some(value => !['codex', 'claude', 'pi'].includes(value))) fail('请选择支持聊天的本机助手');
    const agentIds = [...new Set(body.agentIds)];
    // Validate the entire fresh inventory before changing any relationship.
    for (const agentId of agentIds) {
      const agent = detected.agents.find(item => item.id === agentId);
      if (!agent?.installed || agent.execution?.supported !== true) fail('这个助手尚未安装或暂不支持聊天，请重新检查', 409, 'local_agent_unavailable');
    }
    return agentIds.map(agentId => {
      const contact = this.store.require('contact', `agent_${agentId}`);
      if (contact.added === false) this.store.put('contact', { ...contact, added: true, addedAt: now() });
      return this.publicContact(this.store.require('contact', contact.id));
    });
  }

  saveContact(body, contactId) {
    const previous = contactId ? this.store.require('contact', contactId) : null;
    if (contactId === SELF) fail('本机本人身份不能通过联系人编辑');
    if (previous && body.version !== previous.version) fail('联系人已更新，请重新打开后编辑', 409, 'version_conflict');
    const kind = body.kind ?? previous?.kind;
    if (!['agent', 'human'].includes(kind) || (previous && kind !== previous.kind)) fail('联系人类型必须为人或 Agent，保存后不能更换');
    const name = text(body.name ?? previous?.name, 80), handle = text(body.handle ?? previous?.handle, 32).toLowerCase();
    if (!name) fail('请填写联系人名称');
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(handle) || ['all', 'you', 'self'].includes(handle)) fail('用户名使用 2–32 位小写字母、数字、下划线或短横线，并以字母开头');
    if (this.store.list('contact').some(c => c.id !== contactId && c.handle === handle)) fail('这个用户名已被使用', 409, 'handle_taken');
    let binding = body.binding ?? previous?.binding ?? null;
    if (kind === 'agent') {
      if (binding?.type === 'local') {
        if (!this.store.get('contact', `agent_${binding.localAgentId}`)) fail('请先发现这个本机助手');
        binding = { type: 'local', localAgentId: binding.localAgentId };
      } else if (binding?.type === 'connection') {
        this.store.require('connection', binding.connectionId);
        binding = { type: 'connection', connectionId: binding.connectionId };
      } else fail('请为 Agent 选择一个已发现的助手或连接');
      if (previous?.discovered && JSON.stringify(binding) !== JSON.stringify(previous.binding)) fail('系统联系人不能更换执行后端，请创建新身份');
    } else if (binding) fail('人类联系人不能绑定 Agent 后端');
    const color = body.color ?? previous?.color ?? 'blue';
    if (!colors.includes(color)) fail('请选择提供的头像颜色');
    let configuration;
    try { configuration = validateConfiguration(body.configuration ?? previous?.configuration ?? {}); } catch (error) { fail(error.message); }
    const toolConnection = binding?.type === 'connection' && this.store.require('connection', binding.connectionId).type === 'mcp';
    let chatBackend = body.chatBackend === undefined ? previous?.chatBackend || null : body.chatBackend;
    if (chatBackend) {
      if (!toolConnection || chatBackend.type !== 'local' || !['codex', 'claude', 'pi'].includes(chatBackend.localAgentId) || !this.store.get('contact', `agent_${chatBackend.localAgentId}`)) fail('工具连接的聊天助手必须是已发现、支持执行的本机助手');
      chatBackend = { type: 'local', localAgentId: chatBackend.localAgentId };
    }
    if (kind === 'agent' && binding?.type === 'connection' && !chatBackend && (configuration.modelMode !== 'follow' || configuration.thinking !== 'follow')) fail('这个连接由服务管理模型，不能使用本机 CLI 模型选项');
    const icon = body.icon ?? previous?.icon ?? 'auto';
    if (!icons.includes(icon)) fail('请选择支持的联系人图标');
    const savedId = contactId || id('contact');
    let avatar = previous?.avatar || null;
    if (body.avatar !== undefined) {
      if (kind !== 'agent' && body.avatar !== null) fail('机器人头像仅用于 Agent');
      try { avatar = body.avatar === null ? null : normalizeAgentAvatar(body.avatar); } catch (error) { fail(error.message); }
    } else if (!previous && kind === 'agent') avatar = defaultAgentAvatar({ id: savedId, name, color });
    const contact = this.store.put('contact', { ...previous, id: savedId, kind, name, handle,
      description: text(body.description ?? previous?.description, 300), instructions: kind === 'agent' ? text(body.instructions ?? previous?.instructions, 3000) : '',
      binding, color, icon, avatar, ...(kind === 'agent' ? { configuration, chatBackend: toolConnection ? chatBackend : null } : {}), version: (previous?.version || 0) + 1, createdAt: previous?.createdAt || now(), updatedAt: now() });
    if (previous && JSON.stringify(previous.binding) !== JSON.stringify(contact.binding)) for (const thread of this.store.list('thread').filter(item => item.memberIds?.includes(contact.id))) this.options.onGroupChanged?.(thread.id);
    return this.publicContact(contact);
  }

  members(values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > 30 || values.some(v => typeof v !== 'string')) fail('请选择 1–30 位联系人');
    const ids = [...new Set([SELF, ...values])];
    for (const memberId of ids) this.store.require('contact', memberId);
    if (ids.length < 2) fail('请选择至少一位其他联系人');
    return ids;
  }
  createChat(body) {
    if (body.allowSilence !== undefined && body.allowSilence !== null && typeof body.allowSilence !== 'boolean') fail('允许静默必须是开关或跟随 IM 设置');
    if (!['direct', 'group'].includes(body.kind)) fail('请选择私聊或群聊');
    if (body.kind !== 'group' && body.groupAvatar !== undefined) fail('只有群聊可以设置群图标');
    const groupAvatar = body.kind === 'group' ? validateGroupAvatar(body.groupAvatar) : null;
    const memberIds = this.members(body.memberIds);
    if (body.kind === 'direct' && memberIds.length !== 2) fail('私聊只能有你和一位联系人');
    if (body.kind === 'direct') {
      const peer = this.store.require('contact', memberIds.find(x => x !== SELF));
      if (peer.added === false) this.store.put('contact', { ...peer, added: true, addedAt: now() });
      const existing = this.store.list('thread').find(t => !t.purpose && t.kind === 'direct' && t.memberIds.includes(memberIds.find(x => x !== SELF)));
      if (existing) return existing;
    }
    const title = body.kind === 'direct' ? this.store.require('contact', memberIds.find(x => x !== SELF)).name : text(body.title, 80);
    if (!title) fail('请填写群名称');
    const thread = { id: id('thr'), kind: body.kind, title, memberIds, version: 1, ...(body.kind === 'group' ? { groupAvatar } : {}),
      members: memberIds.map(contactId => ({ contactId, membershipId: id('membership'), visibleAfterMessageId: null })), responsePolicies: {}, allowSilence: body.allowSilence ?? null,
      status: 'completed', summary: '', createdAt: now(), updatedAt: now(), messages: [], runs: [], artifacts: [], decisions: [], events: [], memoryIds: [] };
    return this.store.put('thread', thread);
  }

  updateChat(threadId, body) {
    const thread = this.store.require('thread', threadId);
    if (thread.kind !== 'group') fail('只有群聊可以修改成员和群响应策略');
    if (body.version !== thread.version) fail('群信息已更新，请重新打开后编辑', 409, 'version_conflict');
    const memberIds = body.memberIds === undefined ? thread.memberIds : this.members(body.memberIds);
    // Ordinary accepted replies retain snapshots; artifact grants are rechecked below.
    const members = memberIds.map(contactId => thread.members.find(m => m.contactId === contactId) || { contactId, membershipId: id('membership'), visibleAfterMessageId: thread.messages.at(-1)?.id || null });
    const responsePolicies = { ...thread.responsePolicies };
    if (body.responsePolicies !== undefined) {
      if (!body.responsePolicies || typeof body.responsePolicies !== 'object' || Array.isArray(body.responsePolicies)) fail('响应策略必须是对象');
      for (const [contactId, policy] of Object.entries(body.responsePolicies)) {
        if (!memberIds.includes(contactId) || this.store.require('contact', contactId).kind !== 'agent' || !policies.includes(policy)) fail('只能设置群内 Agent 的响应策略');
        responsePolicies[contactId] = policy;
      }
    }
    if (body.allowSilence !== undefined && body.allowSilence !== null && typeof body.allowSilence !== 'boolean') fail('允许静默必须是开关或跟随 IM 设置');
    const allowSilence = body.allowSilence === undefined ? thread.allowSilence ?? null : body.allowSilence;
    const groupAvatar = body.groupAvatar === undefined ? thread.groupAvatar ?? null : validateGroupAvatar(body.groupAvatar);
    const title = body.title === undefined ? thread.title : text(body.title, 80);
    if (!title) fail('请填写群名称');
    Object.assign(thread, { title, memberIds, members, responsePolicies, allowSilence, groupAvatar, version: thread.version + 1, updatedAt: now() });
    const saved = this.store.put('thread', thread);
    this.options.onGroupChanged?.(threadId);
    return saved;
  }

  appendMessage(thread, body, validateInput) {
    const basic = validateInput({ ...body, mode: 'local', localAgentId: 'codex', action: undefined });
    const reply = body.replyTo ? thread.messages.find(m => m.id === body.replyTo) : null;
    if (body.replyTo && !reply) fail('回复的消息已不存在');
    const mentions = new Set([...basic.text.matchAll(/(^|[^\p{L}\p{N}_@])@([a-z][a-z0-9_-]{1,31})(?![\p{L}\p{N}_-])/giu)].map(m => m[2].toLowerCase()));
    const targets = thread.memberIds.filter(x => x !== SELF).map(x => this.publicContact(this.store.require('contact', x))).filter(contact => {
      if (contact.kind !== 'agent') return false;
      if (thread.kind === 'direct') return true;
      const policy = thread.responsePolicies[contact.id] || 'auto';
      return policy !== 'manual' && (policy === 'auto' || policy === 'always' || mentions.has('all') || mentions.has(contact.handle) || reply?.contactId === contact.id);
    });
    const skippedContacts = [];
    const inputs = targets.flatMap(contact => {
      const uncertain = thread.runs.some(run => run.contactId === contact.id && (this.store.unresolved(run) || run.requiresReconciliation));
      if (contact.availability !== 'ready' || uncertain) {
        const reason = uncertain ? '原任务结果尚未核查' : contact.configurationError || contact.availabilityReason || '连接或登录暂不可用';
        if (thread.kind === 'direct' || mentions.has(contact.handle) || reply?.contactId === contact.id) fail(`${contact.name} 暂时不能回复：${reason}，请在联系人或原任务中处理`, 409, 'agent_unavailable');
        skippedContacts.push({ id: contact.id, name: contact.name, reason });
        return [];
      }
      const binding = contact.binding;
      const input = validateInput({ ...body, mode: binding.type === 'local' ? 'codex' : 'connection',
        localAgentId: binding.localAgentId || contact.chatBackend?.localAgentId || 'codex', connectionId: binding.connectionId, action: undefined });
      const goal = this.store.get('agent_control', contact.id)?.goal;
      return [{ ...input, ...(contact.execution ? { executionSnapshot: structuredClone(contact.execution) } : {}), contactId: contact.id, contactSnapshot: { ...identity(contact), ...(goal?.text ? { goal: structuredClone(goal) } : {}) },
        imPolicy: { allowSilence: (thread.responsePolicies[contact.id] !== 'always') && (thread.allowSilence ?? imSettings(this.store).allowSilence), allowReactions: true },
        participantMemberships: structuredClone(thread.members),
        participantSnapshot: thread.memberIds.map(x => { const { instructions: _instructions, ...peer } = identity(this.store.require('contact', x)); return peer; }),
        conversationSnapshot: { kind: thread.kind, title: thread.title, version: thread.version,
          ...(thread.kind === 'direct' && contact.systemRole === 'guide' ? { guide: this.options.guideContext?.() } : {}),
          attention: { addressedContactIds: thread.memberIds.filter(contactId => {
            const member = this.store.require('contact', contactId);
            return member.kind === 'agent' && (mentions.has('all') || mentions.has(member.handle));
          }), replyToContactId: reply?.contactId || null,
          explicitlyAddressed: thread.kind === 'direct' || mentions.has('all') || mentions.has(contact.handle) || reply?.contactId === contact.id } },
        visibleAfterMessageId: thread.members.find(m => m.contactId === contact.id)?.visibleAfterMessageId || null,
        responsePolicy: thread.kind === 'direct' ? 'direct' : thread.responsePolicies[contact.id] || 'auto' }];
    });
    let messageId;
    for (const input of inputs) {
      const run = this.store.appendRun(thread, { ...input, ...(messageId ? { reuseMessageId: messageId } : {}) });
      messageId = run.messageId;
    }
    if (!inputs.length) {
      messageId = id('msg');
      thread.messages.push({ id: messageId, role: 'user', text: basic.text, attachments: basic.attachments.map(a => ({ ...a, id: id('att'), size: Buffer.byteLength(a.text) })), createdAt: now() });
    }
    const message = thread.messages.find(m => m.id === messageId);
    Object.assign(message, { contactId: SELF, recipientIds: [...thread.memberIds], replyTo: reply?.id || null, ...(skippedContacts.length ? { skippedContacts } : {}), deliveryState: thread.memberIds.some(x => x !== SELF && this.store.require('contact', x).kind === 'human') ? 'local_only' : 'saved' });
    if (!inputs.length) thread.summary = basic.text.slice(0, 120);
    thread.updatedAt = now();
    return this.store.put('thread', thread);
  }

  settings() { return imSettings(this.store); }
  saveSettings(body) {
    const previous = this.settings();
    if (body.version !== previous.version) fail('IM 设置已更新，请刷新后重试', 409, 'version_conflict');
    if (typeof body.allowSilence !== 'boolean') fail('允许静默必须是开关');
    return this.store.put('setting', { id: 'im', version: previous.version + 1, allowSilence: body.allowSilence, updatedAt: now() });
  }
  react(threadId, body) {
    const thread = this.store.require('thread', threadId);
    if (!thread.kind || !REACTIONS.includes(body.emoji) || typeof body.active !== 'boolean') fail('请选择有效的消息表情和操作');
    const message = thread.messages.find(item => item.id === body.messageId && item.role !== 'system');
    if (!message) fail('找不到这条聊天消息', 404, 'not_found');
    if (body.active) addReaction(message, { emoji: body.emoji, contactId: SELF, contactSnapshot: identity(this.store.require('contact', SELF)), createdAt: now(), recipientIds: [...thread.memberIds] });
    else message.reactions = (message.reactions || []).filter(reaction => reaction.contactId !== SELF || reaction.emoji !== body.emoji);
    thread.updatedAt = now(); return this.store.put('thread', thread);
  }

  approvals() {
    return this.store.list('thread').flatMap(thread => thread.decisions.map(decision => {
      const run = thread.runs.find(r => r.id === decision.runId);
      const connectionId = decision.providerConnectionId || run?.connectionId;
      const connection = connectionId ? this.store.get('connection', connectionId) : null;
      const native = connectionId ? this.store.get('native_approval_source', connectionId) : null;
      const linkedContact = decision.providerConnectionId ? this.store.get('contact', `connection_${decision.providerConnectionId}`) : null;
      const localName = run?.localAgentId ? ({ codex: 'Codex', claude: 'Claude Code', pi: 'Pi', gemini: 'Gemini CLI', opencode: 'OpenCode' }[run.localAgentId] || run.localAgentId) : null;
      const source = {
        label: native ? 'Grok Bot' : connection ? connection.type === 'mcp' ? 'MCP 工具' : '远端 Agent' : run?.mode === 'connection' || decision.providerConnectionId ? '来源待核对' : localName || '来源待核对',
        name: connection?.name || decision.identity?.label || null,
        connectionId: connectionId || null,
        botId: native?.instanceId || null,
        requestText: thread.messages.find(message => message.id === run?.messageId && message.role === 'user')?.text || null,
        threadKind: thread.kind || 'task',
      };
      return { ...decision, threadId: thread.id, threadTitle: thread.title, contact: run?.contactSnapshot || (linkedContact ? this.publicContact(linkedContact) : null), source };
    })).sort((a, b) => (a.state === 'pending' ? 0 : 1) - (b.state === 'pending' ? 0 : 1) || String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}
