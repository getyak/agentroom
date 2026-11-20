import { publicAgentInfo } from './agent-info.mjs';
import http from 'node:http';
import { hostname } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { APIError, digest, id, now } from './store.mjs';
import { isTailnetIP, tailnetAddresses } from './device-network.mjs';

const opaque = /^[A-Za-z0-9_-]{1,160}$/;
const fail = (status, code, message) => { throw new APIError(status, code, message); };
const active = ['queued', 'running', 'verifying', 'needs_input', 'unknown'];
const chatCLIs = new Set(['codex', 'claude', 'pi']);

function dispatchContext(parts) {
  const content = parts.map(part => part.text).join('\n\n');
  let payload;
  if (parts.length === 1) {
    try { payload = JSON.parse(content); } catch { /* Direct A2A callers can use a plain text part. */ }
  }
  if (typeof payload?.request !== 'string' || !payload.request.trim()) return { request: content, content: '' };
  // Older receivers can send a fresh ID when interpreting a result as an A2A tool round.
  if (payload.agentroomTools && (payload.toolResults?.length || payload.omittedToolResults > 0)) {
    fail(409, 'device_tool_round_unsupported', '请核查原设备任务，命令没有再次执行');
  }
  const messages = payload.context?.messages;
  const references = Array.isArray(messages) && messages.length ? { messages } : { sources: payload.sources };
  return { request: payload.request, content: JSON.stringify(references), legacyToolRounds: Boolean(payload.agentroomTools) };
}

function legacyDeviceReply(text) {
  try {
    const result = JSON.parse(text);
    if (result?.action === 'tool_call') return ['```json', JSON.stringify(result, null, 2), '```'].join('\n');
  } catch { /* Forward ordinary Markdown unchanged. */ }
  return text;
}

/** A narrow device protocol. The personal HTTP API is never network-exposed. */
export class DesktopSharing {
  constructor(store, messenger, { refresh, validateInput, kick, notify, addresses = tailnetAddresses, port = 18750 }) {
    Object.assign(this, { store, messenger, refresh, validateInput, kick, notify, addresses, port });
    this.identity = store.get('setting', 'sharing-identity') || store.put('setting', { id: 'sharing-identity', nodeId: id('node') });
    this.server = null; this.closed = false; this.error = ''; this.operation = Promise.resolve();
  }
  config() { return this.store.get('setting', 'device-sharing'); }
  contacts() {
    return this.messenger.contacts().filter(contact => contact.kind === 'agent' && !contact.externalGuest && !contact.groupLegacy && contact.binding &&
      !(contact.binding.type === 'connection' && this.store.get('connection', contact.binding.connectionId)?.node));
  }
  access(contact, trusted) {
    const binding = contact.binding;
    if (binding.type === 'local') {
      if (trusted) return 'tools';
      return chatCLIs.has(binding.localAgentId) && contact.execution?.runtime?.protocol !== 'acp' ? 'chat' : 'source';
    }
    const connection = this.store.get('connection', binding.connectionId);
    return trusted && connection && (connection.type === 'a2a' || connection.type === 'mcp' && contact.chatBackend) ? 'tools' : 'source';
  }
  assertRun(thread, run) {
    if (thread.purpose !== 'device_request') return undefined;
    if (!run.deviceToolGrant) {
      if (run.mode === 'codex' && chatCLIs.has(run.localAgentId) && run.executionSnapshot?.runtime?.protocol !== 'acp') return 'chat';
      fail(403, 'device_tools_required', '来源设备尚未授权这次工具执行');
    }
    const config = this.config(), grant = run.deviceToolGrant;
    const contact = this.store.get('contact', run.contactId);
    const binding = contact?.binding;
    const sameBinding = binding?.type === 'local' ? run.mode === 'codex' && binding.localAgentId === run.localAgentId
      : binding?.type === 'connection' && run.mode === 'connection' && binding.connectionId === run.connectionId &&
        !this.store.get('connection', binding.connectionId)?.node;
    if (this.closed || this.suspended || !config?.enabled || config.toolGrantVersion !== grant.version ||
        !config.trustedPeerAddresses?.includes(grant.address) || !config.contactIds.includes(run.contactId) ||
        !sameBinding || contact.externalGuest || contact.groupLegacy) {
      fail(403, 'device_tools_revoked', '本次请求的设备或联系人授权已改变，任务未派发');
    }
    return 'tools';
  }
  status() {
    const config = this.config(), selected = new Set(config?.contactIds || []);
    return { enabled: Boolean(config?.enabled), trustedPeerAddresses: config?.trustedPeerAddresses || [], name: config?.name || hostname().replace(/\.local$/, ''), addresses: this.addresses(),
      host: config?.host || this.addresses()[0] || '', url: this.server?.listening ? `http://${config.host}:${this.server.address().port}` : null,
      state: this.server?.listening ? 'online' : config?.enabled ? 'unavailable' : 'disabled', error: this.error,
      contacts: this.contacts().map(c => ({ id: c.id, name: c.name, selected: selected.has(c.id), canChat: this.access(c, false) === 'chat', canUseTools: this.access(c, true) === 'tools', availability: c.availability })),
      requests: this.store.list('shared_task').slice(0, 30).map(task => ({ id: task.id, contactName: task.contactName, threadId: task.threadId, createdAt: task.createdAt, state: this.taskView(task).status.state })) };
  }
  save(body) {
    const work = () => this.apply(body);
    const pending = this.operation.then(work, work); this.operation = pending.catch(() => {}); return pending;
  }
  async apply(body) {
    if (this.closed) fail(503, 'sharing_closed', '设备共享正在关闭');
    if (!body || typeof body.enabled !== 'boolean' || Object.keys(body).some(k => !['enabled', 'host', 'name', 'contactIds', 'trustedPeerAddresses'].includes(k))) fail(400, 'invalid_sharing', '请检查设备共享设置');
    const previous = this.config();
    if (!body.enabled) {
      if (previous) this.store.put('setting', { ...previous, enabled: false, toolGrantVersion: id('tools') });
      await this.stopListener(); this.error = ''; this.notify(); return this.status();
    }
    await this.refresh();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const contacts = this.contacts();
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || !this.addresses().includes(body.host) ||
      !Array.isArray(body.contactIds) || body.contactIds.length > 100 || body.contactIds.some(value => !contacts.some(c => c.id === value))) {
      fail(400, 'invalid_sharing', '请选择本机 Tailscale 地址、设备名称和要共享的联系人');
    }
    const existingPeers = previous?.trustedPeerAddresses || [];
    const addresses = Object.hasOwn(body, 'trustedPeerAddresses') ? body.trustedPeerAddresses : existingPeers;
    if (!Array.isArray(addresses) || addresses.length > 20 ||
        addresses.some(address => !isTailnetIP(address) && !(body.host === '127.0.0.1' && address === '127.0.0.1'))) {
      fail(400, 'invalid_trusted_peers', '请输入受信任设备的 Tailscale IPv4 地址');
    }
    const trustedPeerAddresses = [...new Set(addresses)].sort();
    const contactIds = [...new Set(body.contactIds)];
    const sameGrant = previous?.host === body.host && JSON.stringify(trustedPeerAddresses) === JSON.stringify(existingPeers) &&
      previous.contactIds.length === contactIds.length && contactIds.every(contactId => previous.contactIds.includes(contactId));
    const config = { id: 'device-sharing', type: 'sharing', url: 'agentroom:device-sharing', credentialVersion: 1,
      name, host: body.host, contactIds, enabled: true, trustedPeerAddresses,
      toolGrantVersion: (sameGrant && previous.toolGrantVersion) || id('tools') };
    if (previous?.credentialRef) Object.assign(config, { generation: previous.generation, credentialRef: previous.credentialRef, tokenHash: previous.tokenHash });
    else {
      const token = randomBytes(32).toString('base64url');
      Object.assign(config, { generation: id('generation'), tokenHash: digest(token), credentialRef: this.store.vault.create(token, config) });
    }
    await this.stopListener();
    this.store.put('setting', config);
    await this.listen(); this.notify(); return this.status();
  }
  invitation() {
    const config = this.config();
    if (!config?.enabled || !this.server?.listening) fail(409, 'sharing_unavailable', '请先开启设备共享，并确认 Tailscale 已连接');
    return { url: this.status().url, token: this.store.vault.authorization(config).Authorization.slice(7) };
  }
  async listen() {
    if (this.binding) return this.binding;
    const config = this.config();
    if (this.closed || !config?.enabled || this.server?.listening) return;
    if (!this.addresses().includes(config.host)) { this.error = '没有找到原 Tailscale 地址，请连接 Tailscale 后重试'; return; }
    const server = http.createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 15_000; server.headersTimeout = 10_000;
    server.maxConnections = 32;
    this.server = server;
    const binding = new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.port, config.host, resolve); });
    this.binding = binding;
    try {
      await binding;
      if (this.port === 0) this.port = server.address().port;
      if (this.closed || this.server !== server || !this.config()?.enabled) {
        if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        return;
      }
      this.error = '';
    }
    catch { this.server = null; this.error = '共享端口暂时不可用，请检查 Tailscale 或端口占用'; }
    finally { if (this.binding === binding) this.binding = null; }
    server.on('error', () => { this.error = '设备共享连接中断，请重新开启共享'; this.notify(); });
  }
  start() {
    void this.saveStartup();
    this.timer = setInterval(() => { if (!this.closed) this.operation = this.operation.then(() => this.listen()).catch(() => {}); }, 15_000);
    this.timer.unref();
  }
  async saveStartup() { this.operation = this.operation.then(() => this.listen()); await this.operation; }
  async stopListener() {
    const server = this.server; this.server = null;
    await this.binding?.catch(() => {});
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.operation; await this.stopListener(); }
  taskView(task) {
    const thread = this.store.get('thread', task.threadId), run = thread?.runs[0];
    const awaitingProvider = run?.status === 'blocked' && run.requiresReconciliation && ['input-required', 'auth-required'].includes(run.remoteStatus);
    const state = awaitingProvider ? run.remoteStatus : ({ queued: 'submitted', running: 'working', verifying: 'working', needs_input: 'input-required', blocked: 'failed', cancelled: 'canceled' })[run?.status] || run?.status || 'unknown';
    const artifact = run?.status === 'completed' && thread.artifacts.find(item => item.runId === run.id);
    const reply = run?.status === 'completed'
      ? thread.messages.filter(m => m.role === 'assistant' && m.runId === run.id).map(m => m.text).join('\n\n') ||
        (artifact && this.store.get('artifact', artifact.id)?.body) || ''
      : '';
    const statusMessage = run?.error || (state === 'input-required' ? '请在来源设备查看并处理这次请求的审批。' : '');
    return { kind: 'task', id: task.messageId, status: { state, timestamp: run?.finishedAt || thread?.updatedAt || task.createdAt,
      ...(statusMessage ? { message: { kind: 'message', role: 'agent', messageId: `${task.messageId}_status`, parts: [{ kind: 'text', text: statusMessage }] } } : {}) },
      metadata: { nodeId: this.identity.nodeId, uncertain: state === 'unknown', externalEffectsVerified: false },
      ...(reply ? { artifacts: [{ artifactId: `${task.messageId}_result`, parts: [{ kind: 'text', text: task.legacyToolRounds ? legacyDeviceReply(reply) : reply }] }] } : {}) };
  }
  async handle(request, response) {
    let rpcId = null;
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(this.store.vault.redact(body))); };
    try {
      const config = this.config(), token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      if (!config?.enabled || !timingSafeEqual(Buffer.from(digest(token)), Buffer.from(config.tokenHash || digest('')))) fail(401, 'unauthorized', '设备访问令牌无效');
      if (this.closed || this.suspended) fail(503, 'sharing_paused', '工作区正在关闭或切换');
      if (request.headers.origin || request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'browser_forbidden', '请通过 AgentRoom 连接设备');
      const address = request.socket.remoteAddress?.replace(/^::ffff:/, '');
      if (!isTailnetIP(address) && !(config.host === '127.0.0.1' && address === '127.0.0.1')) fail(403, 'tailnet_required', '设备共享仅允许 Tailscale 网络');
      if (request.headers.host !== new URL(this.status().url).host) fail(403, 'host_forbidden', '设备地址不匹配');
      const generation = config.generation;
      const current = () => { const value = this.config(); if (this.closed || this.suspended || !value?.enabled || value.generation !== generation) fail(401, 'sharing_revoked', '这次共享已停用'); return value; };
      const trusted = config => config.trustedPeerAddresses?.includes(address) === true;
      const assertTask = (task, config) => {
        if (!task || task.contactId !== contactId || (task.devicePeer && (task.devicePeer !== address || !trusted(config)))) {
          fail(404, 'task_not_found', '这个联系人没有该任务');
        }
      };
      if (request.method === 'GET' && request.url === '/.well-known/agentroom-node.json') {
        await this.refresh(); const latest = current(), origin = this.status().url;
        return send(200, { protocol: 'agentroom-node/1', kind: 'desktop', id: this.identity.nodeId, name: latest.name,
          agents: this.contacts().filter(c => latest.contactIds.includes(c.id)).map(c => {
            const runs = this.store.list('thread').flatMap(t => t.runs).filter(r => r.contactId === c.id);
            const deviceAccess = this.access(c, trusted(latest));
            return { id: c.id, name: c.name, description: c.description, agentInfo: publicAgentInfo(c.agentInfo), url: `${origin}/agents/${c.id}`, taskIdScheme: 'messageId',
              deviceAccess, availability: deviceAccess === 'source' ? 'unsupported' : c.availability === 'ready' ? 'configured' : c.availability,
              activity: { running: runs.filter(r => ['running', 'verifying'].includes(r.status)).length, waiting: runs.filter(r => r.status === 'needs_input').length } };
          }) });
      }
      const match = request.url?.match(/^\/agents\/([A-Za-z0-9_-]{1,160})$/);
      if (request.method !== 'POST' || !match) fail(404, 'not_found', '未知设备接口');
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'content_type', '请求必须使用 JSON');
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 2_000_000) fail(413, 'request_too_large', '消息超过大小限制'); chunks.push(chunk); }
      let rpc;
      try { rpc = JSON.parse(Buffer.concat(chunks)); } catch { fail(400, 'invalid_json', '消息不是有效 JSON'); }
      if (rpc?.jsonrpc !== '2.0' || !['number', 'string'].includes(typeof rpc.id)) fail(400, 'invalid_rpc', '无效的设备请求');
      rpcId = rpc.id;
      const contactId = match[1];
      if (rpc.method === 'tasks/get') {
        if (!opaque.test(rpc.params?.id || '')) fail(400, 'invalid_task', '任务标识无效');
        const task = this.store.get('shared_task', `${generation}_${rpc.params.id}`);
        assertTask(task, current());
        return send(200, { jsonrpc: '2.0', id: rpcId, result: this.taskView(task) });
      }
      if (rpc.method !== 'message/send') fail(400, 'method_not_found', '不支持此设备操作');
      const message = rpc.params?.message;
      if (message?.kind !== 'message' || message.role !== 'user' || typeof message.messageId !== 'string' || message.messageId.length < 8 || !opaque.test(message.messageId) ||
        !Array.isArray(message.parts) || !message.parts.length || message.parts.length > 20 || message.parts.some(p => p?.kind !== 'text' || typeof p.text !== 'string' || !p.text.trim())) fail(400, 'invalid_message', '请输入带稳定标识的文本消息');
      const taskId = `${generation}_${message.messageId}`, fingerprint = digest(JSON.stringify({ contactId, message }));
      const previous = this.store.get('shared_task', taskId);
      if (previous) {
        assertTask(previous, current());
        if (previous.fingerprint !== fingerprint) fail(409, 'idempotency_conflict', '相同消息标识的内容发生变化');
        return send(200, { jsonrpc: '2.0', id: rpcId, result: this.taskView(previous) });
      }
      await this.refresh(); const latest = current();
      const contact = this.contacts().find(c => c.id === contactId && latest.contactIds.includes(c.id));
      const access = contact ? this.access(contact, trusted(latest)) : 'source';
      if (access === 'source') fail(409, 'contact_unavailable', '这位联系人需要从来源设备或受信任的设备使用');
      const { request: userRequest, content, legacyToolRounds } = access === 'tools' ? dispatchContext(message.parts)
        : { request: '请以你的联系人身份回复对方提供的对话。只使用所附内容，不读取这台机器的其他聊天或记忆。', content: message.parts.map(p => p.text).join('\n\n') };
      const task = this.store.transaction(() => {
        // Discovery yielded: a duplicate may already have committed.
        const existing = this.store.get('shared_task', taskId);
        if (existing) { if (existing.fingerprint !== fingerprint) fail(409, 'idempotency_conflict', '消息标识冲突'); return existing; }
        if (this.store.list('shared_task').filter(t => active.includes(this.store.get('thread', t.threadId)?.runs[0]?.status)).length >= 100) fail(429, 'queue_full', '设备待处理消息已满，请稍后再试');
        const stamp = now(), thread = { id: id('thr'), purpose: 'device_request', title: `设备消息 · ${contact.name}`, kind: 'direct', memberIds: ['self', contact.id],
          members: [{ contactId: 'self', visibleAfterMessageId: null }, { contactId: contact.id, visibleAfterMessageId: null }], responsePolicies: {}, allowSilence: false, version: 1,
          createdAt: stamp, updatedAt: stamp, status: 'queued', summary: '', messages: [], runs: [], artifacts: [], decisions: [], events: [], memoryIds: [] };
        const attachments = [];
        for (let offset = 0; offset < content.length; offset += 450_000) attachments.push({ name: `对方提供的对话-${attachments.length + 1}.txt`, text: content.slice(offset, offset + 450_000) });
        this.store.put('thread', thread);
        const accepted = this.messenger.appendMessage(thread, { text: userRequest, attachments }, this.validateInput);
        if (access === 'tools') {
          accepted.runs[0].deviceToolGrant = { version: latest.toolGrantVersion, address };
          this.store.put('thread', accepted);
        }
        return this.store.put('shared_task', { id: taskId, messageId: message.messageId, generation, contactId, contactName: contact.name, fingerprint,
          threadId: thread.id, createdAt: stamp, ...(access === 'tools' ? { devicePeer: address, ...(legacyToolRounds ? { legacyToolRounds } : {}) } : {}) });
      });
      this.kick(); this.notify(); return send(200, { jsonrpc: '2.0', id: rpcId, result: this.taskView(task) });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(error.status || 500, { jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: error.status ? error.message : '设备请求未完成，请核查原任务' } });
    }
  }
}
