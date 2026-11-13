import { APIError, digest, id, now } from './store.mjs';
import { validateBearerToken } from './vault.mjs';

const invalid = () => new APIError(400, 'invalid_nango_connection', '请核对 Nango 地址、API key、集成和连接 ID；工具名称必须逐项填写，不能使用通配符');
const unknown = () => new APIError(502, 'nango_session_outcome_unknown', 'Nango 会话创建结果尚未确认，未自动重试。请先到 Nango 核对；已有连接可手动续期');
const upstream = () => new APIError(502, 'invalid_nango_session', 'Nango 没有返回有效的限时会话；原连接已保留');
const sessionId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);

function baseURL(value = 'https://api.nango.dev') {
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw invalid();
  return url.origin;
}
function label(value, maximum = 200) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value;
}
function scope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key =>
    !['baseUrl', 'apiKey', 'integrationId', 'connectionId', 'toolNames', 'clientId'].includes(key))) throw invalid();
  const integrationId = label(input.integrationId, 80), upstreamConnectionId = label(input.connectionId);
  const toolNames = input.toolNames ?? [];
  if (!Array.isArray(toolNames) || toolNames.length > 100 || toolNames.some(name => typeof name !== 'string' || /[*?]/.test(name))) throw invalid();
  toolNames.forEach(name => label(name));
  return { baseUrl: baseURL(input.baseUrl), integrationId, upstreamConnectionId, toolNames: [...new Set(toolNames)] };
}
function publicResult(connection, metadata) {
  return { id: connection.id, name: connection.name, type: connection.type, url: connection.url, createdAt: connection.createdAt,
    auth: { type: 'bearer', configured: true, identityVerified: false }, status: connection.checkedAt ? 'checked' : 'configured',
    checkedAt: connection.checkedAt || null, capabilities: ['tools/list', 'approved tools/call'],
    nango: { integrationId: metadata.integrationId, expiresAt: metadata.expiresAt } };
}
async function boundedJSON(response, signal) {
  if (!/\bjson\b/i.test(response.headers.get('content-type') || '')) throw upstream();
  const reader = response.body?.getReader();
  if (!reader) throw upstream();
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > 128_000) throw upstream();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { void reader.cancel().catch(() => {}); }
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Backend-only administrator credentials create short-lived, pinned MCP sessions. */
export class NangoConnections {
  constructor(store, { fetch = globalThis.fetch, saveConnection, timeoutMs = 15_000 }) {
    this.store = store; this.fetch = fetch; this.saveConnection = saveConnection; this.timeoutMs = timeoutMs;
    this.pending = new Map(); this.activeConnections = new Set();
    this.recoverOrphanConnections();
    this.recoverStaging();
  }

  connect(input) {
    let configured, apiKey;
    try { configured = scope(input); apiKey = validateBearerToken(input.apiKey); if (!apiKey) throw invalid(); }
    catch (error) { return Promise.reject(error); }
    this.store.vault.secrets.add(apiKey);
    const fingerprint = { ...configured, authFingerprint: this.store.vault.fingerprint(apiKey, 'nango_admin', configured.baseUrl) };
    return this.operation('connect', input.clientId, fingerprint, async operationReceiptId => {
      const binding = { id: id('nango_admin'), type: 'nango_admin', url: configured.baseUrl, credentialVersion: 1 };
      binding.credentialRef = this.store.vault.create(apiKey, binding);
      try { return await this.install(configured, binding, null, operationReceiptId); }
      catch (error) { if (!this.bindingReferenced(binding.credentialRef)) this.store.vault.remove(binding.credentialRef); throw error; }
    });
  }

  renew(connectionId, input = {}) {
    if (Object.keys(input).some(key => key !== 'clientId')) return Promise.reject(invalid());
    this.store.require('nango_connection', connectionId);
    return this.operation(`renew:${connectionId}`, input.clientId, { connectionId }, async operationReceiptId => {
      if (this.activeConnections.has(connectionId)) throw new APIError(409, 'nango_connection_busy', '这个 Nango 连接正在更新，请稍后核对结果');
      this.activeConnections.add(connectionId);
      try {
        // Reload after operation deduplication, so the persisted binding is authoritative.
        const current = this.store.require('nango_connection', connectionId);
        return await this.install(current, current.adminBinding, this.store.require('connection', connectionId), operationReceiptId);
      } finally { this.activeConnections.delete(connectionId); }
    });
  }

  operation(route, clientId, input, execute) {
    if (clientId !== undefined && (typeof clientId !== 'string' || clientId.length < 8 || clientId.length > 160 || /[\x00-\x1f\x7f]/.test(clientId))) return Promise.reject(invalid());
    const receiptId = digest(JSON.stringify({ route, clientId: clientId ?? id('nango_request') })), fingerprint = digest(JSON.stringify(input));
    const previous = this.store.get('nango_request', receiptId);
    if (previous && previous.fingerprint !== fingerprint) return Promise.reject(new APIError(409, 'idempotency_conflict', '相同 clientId 的 Nango 请求内容不同'));
    if (previous?.status === 'complete') return Promise.resolve(previous.result);
    if (this.pending.has(receiptId)) return this.pending.get(receiptId);
    if (previous) {
      const error = unknown(); error.recovery = this.readRecovery();
      return Promise.reject(error);
    }
    this.store.put('nango_request', { id: receiptId, fingerprint, status: 'pending', createdAt: now() });
    const promise = Promise.resolve().then(() => execute(receiptId)).then(result => {
      this.store.put('nango_request', { id: receiptId, fingerprint, status: 'complete', result });
      return result;
    }, error => {
      const committed = this.store.get('nango_request', receiptId);
      if (committed?.status === 'complete') return committed.result;
      this.store.put('nango_request', { id: receiptId, fingerprint, status: 'unconfirmed' });
      if (error instanceof APIError) throw error;
      throw new APIError(502, 'nango_connection_failed', 'Nango 会话连接失败；原连接已保留，请核对服务状态后手动续期');
    }).finally(() => this.pending.delete(receiptId));
    this.pending.set(receiptId, promise);
    return promise;
  }

  async createSession(configured, binding) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response;
    try {
      response = await abortable(this.fetch(`${configured.baseUrl}/sessions`, { method: 'POST', redirect: 'error', signal,
        headers: { ...this.store.vault.authorization(binding), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ tenant: { connections: { pinned: [{ integration_id: configured.integrationId, connection_id: configured.upstreamConnectionId }] } },
          toolset: { [configured.integrationId]: configured.toolNames.length ? { allow: { tools: configured.toolNames } } : '*' },
          expires_in: '1h', meta_tools: { nango_tool_search: true, nango_execute: true, nango_proxy: false, nango_create_connection: false } }) }), signal);
    } catch { throw unknown(); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status >= 500) throw unknown();
      throw new APIError(502, 'nango_session_rejected', 'Nango 拒绝创建会话，请核对 API key 权限、集成、连接和工具名称');
    }
    let data;
    try { data = (await boundedJSON(response, signal))?.data; }
    catch { throw unknown(); }
    // Register before validation, persistence or error handling can echo provider data.
    if (typeof data?.session_token === 'string' && data.session_token.length <= 8000) this.store.vault.secrets.add(data.session_token);
    return data;
  }

  validateSession(data, configured, binding) {
    if (!data || !this.safeSessionId(data.session_id)) throw upstream();
    const expiresAt = typeof data.expires_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(data.expires_at) ? Date.parse(data.expires_at) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 3_660_000) throw upstream();
    let token, endpoint;
    try { token = validateBearerToken(data.session_token); endpoint = new URL(data.mcp_url); } catch { throw upstream(); }
    if (!token || `Bearer ${token}` === this.store.vault.authorization(binding).Authorization ||
      endpoint.origin !== configured.baseUrl || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== `/session/${data.session_id}/mcp` || this.store.vault.redactString(endpoint.href) !== endpoint.href) throw upstream();
    return { token, url: endpoint.href, sessionId: data.session_id, expiresAt: new Date(expiresAt).toISOString() };
  }

  async install(configured, adminBinding, original = null, operationReceiptId) {
    const existingConnections = this.store.list('connection');
    const existingIds = new Set(existingConnections.map(connection => connection.id));
    let staging = { id: id('nango_stage'), baseUrl: configured.baseUrl, integrationId: configured.integrationId,
      upstreamConnectionId: configured.upstreamConnectionId, toolNames: configured.toolNames, adminBinding, operationReceiptId,
      originalConnectionId: original?.id || null, existingConnectionIds: [...existingIds], status: 'creating', createdAt: now() };
    this.store.put('nango_staging', staging);
    const sessionIsConnected = (remoteId, ignoredId) => {
      const url = `${configured.baseUrl}/session/${remoteId}/mcp`;
      return existingConnections.some(connection => connection.url === url) ||
        this.store.list('connection').some(connection => connection.id !== ignoredId && connection.url === url);
    };
    let data, candidate, candidateCreated = false, replacementRef, committed = false;
    try {
      data = await this.createSession(configured, adminBinding);
      if (this.safeSessionId(data?.session_id)) {
        staging = { ...staging, sessionId: data.session_id, status: 'session_created' };
        this.store.put('nango_staging', staging);
      }
      const session = this.validateSession(data, configured, adminBinding);
      if (sessionIsConnected(session.sessionId)) throw new APIError(409, 'nango_session_already_connected', 'Nango 返回了已有连接正在使用的会话；保留已有连接，未迁移或撤销该会话');
      if (original && configured.sessionId === session.sessionId) throw upstream();
      staging = { ...staging, status: 'verifying', sessionId: session.sessionId, sessionUrl: session.url, expiresAt: session.expiresAt,
        credentialFingerprint: this.store.vault.fingerprint(session.token, 'mcp', session.url) };
      this.store.put('nango_staging', staging);
      const preSaveIds = new Set(this.store.list('connection').map(connection => connection.id));
      candidate = await this.saveConnection({ name: `Nango · ${configured.integrationId}`, type: 'mcp', url: session.url, token: session.token }, { verifyTools: true });
      candidateCreated = !existingIds.has(candidate.id) && !preSaveIds.has(candidate.id);
      if (!candidateCreated) throw new APIError(409, 'nango_session_already_connected', '会话已属于已有连接；保留已有连接，未迁移或撤销该会话');
      const saved = this.store.require('connection', candidate.id);
      const metadata = { id: original?.id || saved.id, baseUrl: configured.baseUrl, integrationId: configured.integrationId,
        upstreamConnectionId: configured.upstreamConnectionId, toolNames: configured.toolNames, adminBinding, sessionId: session.sessionId, expiresAt: session.expiresAt };
      let connection = saved;
      if (original) {
        if (saved.id === original.id) throw upstream();
        connection = { ...saved, id: original.id, name: original.name, createdAt: original.createdAt, credentialVersion: (original.credentialVersion || 0) + 1 };
        replacementRef = this.store.vault.create(session.token, connection);
        connection.credentialRef = replacementRef;
      }
      let result = this.store.vault.redact({ ...publicResult(connection, metadata),
        ...(original ? { previousRemoteRevocation: 'unconfirmed' } : {}) });
      const revocation = original ? { id: id('nango_revocation'), status: 'revocation_unconfirmed', baseUrl: configured.baseUrl,
        integrationId: configured.integrationId, sessionId: configured.sessionId, expiresAt: configured.expiresAt,
        adminBinding, operationReceiptId, connectionId: original.id, createdAt: now() } : null;
      this.store.transaction(() => {
        if (original) {
          // A deletion or credential edit during network verification must not resurrect it.
          const current = this.store.require('connection', original.id);
          if (current.credentialRef !== original.credentialRef || current.url !== original.url || current.credentialVersion !== original.credentialVersion) throw new APIError(409, 'nango_connection_changed', '连接身份已改变，请刷新后再操作');
          this.store.put('connection', connection); this.store.delete('connection', saved.id);
        }
        this.store.put('nango_connection', metadata);
        // Local identity rotation and its known result commit together. Remote
        // revocation remains a separate, durably owned administrative action.
        this.completeReceipt(operationReceiptId, result);
        if (revocation) this.store.put('nango_revocation', revocation);
        this.store.delete('nango_staging', staging.id);
      });
      committed = true;
      let credentialCleanupPending = false, previousRemoteRevocation;
      if (original) {
        for (const cleanup of [() => this.store.vault.removeForConnection(saved.id), () => this.store.vault.remove(original.credentialRef)]) {
          try { cleanup(); } catch { credentialCleanupPending = true; }
        }
        if (credentialCleanupPending) {
          result = { ...result, credentialCleanupPending: true };
          this.completeReceipt(operationReceiptId, result);
        }
        // Revocation does not cancel any tool call already in flight.
        previousRemoteRevocation = await this.revoke(configured.baseUrl, configured.sessionId, adminBinding);
        result = { ...result, previousRemoteRevocation };
        this.store.transaction(() => {
          this.completeReceipt(operationReceiptId, result);
          if (previousRemoteRevocation !== 'unconfirmed') this.store.delete('nango_revocation', revocation.id);
        });
      }
      return result;
    } catch (error) {
      if (!committed) {
        // A verifier can persist before a later local callback fails. Own only
        // candidates matching the journal and absent from its original snapshot.
        if (!candidate && staging.sessionUrl) {
          candidate = this.store.list('connection').find(connection => !existingIds.has(connection.id) &&
            connection.url === staging.sessionUrl && connection.credentialFingerprint === staging.credentialFingerprint);
          candidateCreated = Boolean(candidate);
        }
        if (candidateCreated) { this.store.delete('connection', candidate.id); this.store.vault.removeForConnection(candidate.id); }
        if (replacementRef) this.store.vault.remove(replacementRef);
        let retainStaging = error?.code === 'nango_session_outcome_unknown' || (data != null && !this.safeSessionId(data.session_id));
        if (this.safeSessionId(data?.session_id) && data.session_id !== configured.sessionId &&
          !sessionIsConnected(data.session_id, candidateCreated ? candidate.id : undefined)) {
          const revocation = await this.revoke(configured.baseUrl, data.session_id, adminBinding);
          retainStaging = revocation === 'unconfirmed';
        }
        if (retainStaging) this.store.put('nango_staging', { ...staging, status: 'needs_reconciliation' });
        else this.store.delete('nango_staging', staging.id);
      }
      if (error instanceof APIError) throw error;
      throw new APIError(502, 'nango_connection_failed', 'Nango 会话验证失败；原连接已保留，请核对后手动续期');
    }
  }

  completeReceipt(receiptId, result) {
    const receipt = receiptId && this.store.get('nango_request', receiptId);
    if (receipt) this.store.put('nango_request', { ...receipt, status: 'complete', result });
  }

  bindingReferenced(ref, ignoredConnectionId, ignoredJournalId) {
    return ['nango_connection', 'nango_staging', 'nango_revocation'].some(kind => this.store.list(kind).some(record =>
      !(kind === 'nango_connection' && record.id === ignoredConnectionId) && record.id !== ignoredJournalId && record.adminBinding?.credentialRef === ref));
  }

  readRecovery() {
    const records = [
      ...this.store.list('nango_recovery'),
      ...this.store.list('nango_staging').map(record => ({ ...record, status: 'needs_reconciliation' })),
      ...this.store.list('nango_revocation'),
    ];
    return this.store.vault.redact(records.map(record => ({ id: record.id, status: record.status, integrationId: record.integrationId,
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}), ...(record.connectionId ? { connectionId: record.connectionId } : {}),
      ...(record.originalConnectionId ? { originalConnectionId: record.originalConnectionId } : {}) })));
  }

  async retireRecovery(recoveryId, input = {}) {
    if (typeof recoveryId !== 'string' || !recoveryId || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => key !== 'clientId')) throw invalid();
    const route = 'nango:recovery:retire', safeInput = { recoveryId };
    if (input.clientId !== undefined) {
      const replay = this.store.replay(route, input.clientId, safeInput);
      if (replay.found) return replay.value;
    }
    const kinds = ['nango_staging', 'nango_recovery', 'nango_revocation'];
    const kind = kinds.find(value => this.store.get(value, recoveryId));
    if (!kind) throw new APIError(404, 'not_found', '找不到这条恢复记录');
    const record = this.store.require(kind, recoveryId);
    if (this.pending.has(record.operationReceiptId) || this.activeConnections.has(record.connectionId) ||
      this.activeConnections.has(record.originalConnectionId)) throw new APIError(409, 'nango_recovery_busy', '这个 Nango 操作仍在进行，暂时不能移除恢复记录');
    const retire = () => {
      const ref = record.adminBinding?.credentialRef;
      // Explicit local retirement never recreates a session or retries revocation.
      // Keep the record if encrypted credential cleanup fails, so retry is safe.
      if (ref && !this.bindingReferenced(ref, undefined, recoveryId)) this.store.vault.remove(ref);
      this.store.delete(kind, recoveryId);
      return { id: recoveryId, retired: true };
    };
    return input.clientId !== undefined ? this.store.idempotent(route, input.clientId, safeInput, retire) : this.store.transaction(retire);
  }

  recoverStaging() {
    for (const record of this.store.list('nango_staging')) {
      const candidate = record.sessionUrl && /^[a-f0-9]{64}$/.test(record.credentialFingerprint || '') &&
        this.safeSessionId(record.sessionId) && this.store.list('connection').find(connection =>
        !(record.existingConnectionIds || []).includes(connection.id) && connection.url === record.sessionUrl &&
        connection.credentialFingerprint === record.credentialFingerprint && connection.initializedAt && connection.protocolVersion);
      const current = candidate && this.store.get('nango_connection', candidate.id);
      if (!candidate || (current && current.adminBinding?.credentialRef !== record.adminBinding?.credentialRef)) {
        this.store.put('nango_staging', { ...record, status: 'needs_reconciliation' });
        continue;
      }
      const metadata = { id: candidate.id, baseUrl: record.baseUrl, integrationId: record.integrationId,
        upstreamConnectionId: record.upstreamConnectionId, toolNames: record.toolNames, adminBinding: record.adminBinding,
        sessionId: record.sessionId, expiresAt: record.expiresAt };
      this.store.transaction(() => {
        if (!current) this.store.put('nango_connection', metadata);
        this.store.put('nango_recovery', { id: record.id, status: 'recovered_connection', integrationId: record.integrationId,
          connectionId: candidate.id, expiresAt: record.expiresAt,
          ...(record.originalConnectionId ? { originalConnectionId: record.originalConnectionId } : {}) });
        // An interrupted renewal keeps its original identity. The temporary
        // verified candidate is recovered separately, never silently promoted.
        if (!record.originalConnectionId && record.operationReceiptId) {
          const receipt = this.store.get('nango_request', record.operationReceiptId);
          if (receipt) this.store.put('nango_request', { ...receipt, status: 'complete', result: publicResult(candidate, metadata) });
        }
        this.store.delete('nango_staging', record.id);
      });
    }
  }

  disconnectJournal(metadata) {
    return { id: id('nango_revocation'), purpose: 'disconnect', status: 'revocation_unconfirmed',
      baseUrl: metadata.baseUrl, integrationId: metadata.integrationId, sessionId: metadata.sessionId,
      expiresAt: metadata.expiresAt, adminBinding: metadata.adminBinding, connectionId: metadata.id, createdAt: now() };
  }

  recoverOrphanConnections() {
    for (const metadata of this.store.list('nango_connection')) {
      if (this.store.get('connection', metadata.id)) continue;
      this.store.transaction(() => {
        this.store.put('nango_revocation', this.disconnectJournal(metadata));
        this.store.delete('nango_connection', metadata.id);
      });
    }
  }

  settleDisconnect(journal, remoteRevocation) {
    this.store.put('nango_revocation', { ...journal, status: 'credential_cleanup_pending', remoteRevocation });
    const ref = journal.adminBinding.credentialRef;
    if (!this.bindingReferenced(ref, undefined, journal.id)) this.store.vault.remove(ref);
    this.store.delete('nango_revocation', journal.id);
    return { remoteRevocation };
  }

  safeSessionId(value) {
    return sessionId(value) && this.store.vault.redactString(value) === value;
  }

  async revoke(baseUrl, remoteSessionId, binding) {
    try {
      const authorization = this.store.vault.authorization(binding);
      // Provider data rejected above must not re-enter an outbound URL during cleanup.
      if (!this.safeSessionId(remoteSessionId)) return 'unconfirmed';
      const signal = AbortSignal.timeout(this.timeoutMs);
      const response = await abortable(this.fetch(`${baseUrl}/sessions/${encodeURIComponent(remoteSessionId)}`, {
        method: 'DELETE', redirect: 'error', signal, headers: { ...authorization, Accept: 'application/json' },
      }), signal);
      void response.body?.cancel().catch(() => {});
      return response.ok ? 'revoked' : response.status === 404 ? 'already_absent' : 'unconfirmed';
    } catch { return 'unconfirmed'; }
  }

  async disconnect(connectionId) {
    if (this.activeConnections.has(connectionId)) throw new APIError(409, 'nango_connection_busy', '这个 Nango 连接正在更新，请稍后核对结果');
    const metadata = this.store.get('nango_connection', connectionId);
    if (!metadata) {
      const pending = this.store.list('nango_revocation').find(record => record.purpose === 'disconnect' && record.connectionId === connectionId);
      if (pending?.remoteRevocation && pending.remoteRevocation !== 'unconfirmed') return this.settleDisconnect(pending, pending.remoteRevocation);
      return { remoteRevocation: pending ? 'unconfirmed' : 'not_configured' };
    }
    this.activeConnections.add(connectionId);
    try {
      const journal = this.disconnectJournal(metadata);
      this.store.transaction(() => {
        this.store.put('nango_revocation', journal);
        this.store.delete('nango_connection', connectionId);
      });
      const remoteRevocation = await this.revoke(metadata.baseUrl, metadata.sessionId, metadata.adminBinding);
      return remoteRevocation === 'unconfirmed' ? { remoteRevocation } : this.settleDisconnect(journal, remoteRevocation);
    } finally { this.activeConnections.delete(connectionId); }
  }
}
