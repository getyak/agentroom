import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { CredentialVault } from './vault.mjs';

export const now = () => new Date().toISOString();
export const id = (prefix) => `${prefix}_${randomUUID()}`;
export const digest = (text) => createHash('sha256').update(text).digest('hex');
export const connectionIdentity = connection => ({ connectionId: connection.id, url: connection.url,
  credentialRef: connection.credentialRef || null, credentialVersion: connection.credentialVersion || 0 });

export class APIError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// SQLite owns the durable queue, transcripts, decisions, and immutable deliverables.
// A separate rollback-journal SQLite connection holds an OS-backed exclusive lock
// for the entire worker lifetime. Never unlink its inode: process death releases it.
export class PersonalStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.lockPath = join(dataDir, 'worker-lock.sqlite');
    this.lockDb = new DatabaseSync(this.lockPath);
    // Never open/close this inode through fs: POSIX close would release another
    // SQLite connection's process lock. SQLite must manage every descriptor.
    try { chmodSync(this.lockPath, 0o600); this.lockDb.exec('PRAGMA busy_timeout=100; BEGIN EXCLUSIVE;'); }
    catch { this.lockDb.close(); this.lockDb = null; throw new Error('Personal workspace is already open in another process'); }
    this.databasePath = join(dataDir, 'personal.sqlite');
    try {
      this.db = new DatabaseSync(this.databasePath);
      chmodSync(this.databasePath, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS idempotency(route TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(route,key));`);
      if (!this.db.prepare('PRAGMA table_info(documents)').all().some(column => column.name === 'thread_id')) this.db.exec('ALTER TABLE documents ADD COLUMN thread_id TEXT;');
      // An interrupted migration may already have added the column. Version the
      // backfill separately and atomically, including every thread-owned kind.
      if (this.db.prepare('PRAGMA user_version').get().user_version < 1) {
        this.db.exec(`BEGIN;
          UPDATE documents SET thread_id=json_extract(body,'$.threadId') WHERE json_type(body,'$.threadId')='text';
          INSERT OR IGNORE INTO documents(kind,id,body,thread_id)
          SELECT 'artifact_tool_receipt',id,json_object('id',id,'threadId',thread_id,'contactId',json_extract(body,'$.contactId'),'name',json_extract(body,'$.name'),'state',json_extract(body,'$.state'),'ok',json_extract(body,'$.ok'),'createdAt',json_extract(body,'$.createdAt')),thread_id
          FROM documents WHERE kind='artifact_tool_operation' AND thread_id IS NOT NULL;
          PRAGMA user_version=1; COMMIT;`);
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS documents_thread ON documents(kind,thread_id);');
      this.secureFiles();
      this.vault = new CredentialVault(dataDir);
    } catch (error) {
      this.db?.close(); this.db = null;
      this.lockDb.close(); this.lockDb = null;
      throw error;
    }
  }

  secureFiles() {
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  get(kind, key) {
    const row = this.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get(kind, key);
    return row ? JSON.parse(row.body) : null;
  }

  require(kind, key) {
    const value = this.get(kind, key);
    if (!value) throw new APIError(404, 'not_found', '找不到这条记录');
    return value;
  }

  list(kind) {
    return this.db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY rowid DESC').all(kind).map((row) => JSON.parse(row.body));
  }

  listForThread(kind, threadId, limit = 100) {
    return this.db.prepare('SELECT body FROM documents WHERE kind=? AND thread_id=? ORDER BY rowid DESC LIMIT ?').all(kind, threadId, Math.min(Math.max(limit, 1), 200)).map(row => JSON.parse(row.body));
  }
  assertExecutorReady(agentId) {
    if (this.list('thread').some(thread => thread.runs.some(run => run.stopUnconfirmed && (run.localAgentId || 'codex') === agentId)) || this.list('play_job').some(job => job.backend === agentId && ['unknown', 'stopping'].includes(job.status))) throw new APIError(409, 'local_agent_stop_unconfirmed', '这个本机助手的停止状态尚未确认，请先核查原任务或邀请房间；没有再次启动执行');
  }

  put(kind, value) {
    value = this.vault ? this.vault.redact(value) : value;
    this.db.prepare('INSERT INTO documents(kind,id,body,thread_id) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,thread_id=excluded.thread_id')
      .run(kind, value.id, JSON.stringify(value), value.threadId || null);
    this.secureFiles();
    return value;
  }

  delete(kind, key) { this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind, key); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  idempotent(route, key, input, fn) {
    if (typeof key !== 'string' || key.length < 8 || key.length > 160) {
      throw new APIError(400, 'bad_request', 'clientId 必须是 8–160 字符的唯一请求标识');
    }
    const fingerprint = digest(JSON.stringify(input));
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT fingerprint,body FROM idempotency WHERE route=? AND key=?').get(route, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new APIError(409, 'idempotency_conflict', '相同 clientId 的请求内容不同');
        return JSON.parse(previous.body);
      }
      const result = this.vault.redact(fn());
      this.db.prepare('INSERT INTO idempotency(route,key,fingerprint,body) VALUES(?,?,?,?)').run(route, key, fingerprint, JSON.stringify(result));
      return result;
    });
  }

  replay(route, key, input) {
    if (typeof key !== 'string' || key.length < 8 || key.length > 160) throw new APIError(400, 'bad_request', 'clientId 必须是 8–160 字符的唯一请求标识');
    const previous = this.db.prepare('SELECT fingerprint,body FROM idempotency WHERE route=? AND key=?').get(route, key);
    if (!previous) return { found: false };
    if (previous.fingerprint !== digest(JSON.stringify(input))) throw new APIError(409, 'idempotency_conflict', '相同 clientId 的请求内容不同');
    return { found: true, value: JSON.parse(previous.body) };
  }

  updateThread(threadId, fn) {
    return this.transaction(() => {
      const thread = this.require('thread', threadId);
      fn(thread);
      this.refreshThread(thread);
      thread.updatedAt = now();
      return this.put('thread', thread);
    });
  }

  event(thread, type, text, extra = {}) {
    thread.events.push({ id: id('evt'), type, text, createdAt: now(), ...extra });
  }

  unresolved(run) {
    return run.status === 'unknown' || run.cancelPending || (run.requiresReconciliation && !['queued', 'running', 'verifying'].includes(run.status));
  }

  nextQueuedRun(thread, eligible = () => true) {
    if (thread.kind === 'group') {
      return thread.runs.find((run, index) => run.status === 'queued' && eligible(run) && !thread.runs.slice(0, index).some(previous =>
        previous.contactId === run.contactId && (['queued', 'running', 'verifying', 'needs_input'].includes(previous.status) || this.unresolved(previous)))) || null;
    }
    let index = thread.runs.findIndex((run) => run.status === 'queued');
    // Owner messages can pass waiting goal ticks, never running or uncertain work.
    const ownerIndex = thread.runs.findIndex(run => run.status === 'queued' && !run.agentSchedule);
    if (ownerIndex >= 0 && !thread.runs.slice(0, ownerIndex).some(run => ['running', 'verifying', 'needs_input'].includes(run.status) || this.unresolved(run) || (run.status === 'queued' && !run.agentSchedule))) index = ownerIndex;
    if (index < 0 || thread.runs.slice(0, index).some((run) => ['running', 'verifying', 'needs_input'].includes(run.status) || this.unresolved(run) || (run.status === 'queued' && (!run.agentSchedule || thread.runs[index].agentSchedule)))) return null;
    return eligible(thread.runs[index]) ? thread.runs[index] : null;
  }

  refreshThread(thread) {
    const unknown = thread.runs.find((run) => this.unresolved(run) && !run.cancelPending);
    const stopping = thread.runs.find(run => run.cancelPending);
    const queued = thread.runs.filter((run) => run.status === 'queued');
    const active = thread.runs.find((run) => ['running', 'verifying'].includes(run.status));
    const pending = thread.runs.find((run) => run.status === 'needs_input');
    if (unknown) {
      thread.status = 'unknown';
      thread.summary = queued.length ? '原任务结果尚未确认；补充已保存，核查后再继续' : unknown.error || '远端执行尚未确认，请先核查原任务';
    } else if (stopping) {
      thread.status = 'running'; thread.summary = '已请求停止，正在确认本机助手退出';
    } else if (active) {
      thread.status = active.status;
      if (queued.length) thread.summary = '补充已保存，会在当前运行结束后接着处理';
    } else if (pending) {
      thread.status = 'needs_input';
      if (queued.length) thread.summary = '等待核对当前预览；补充已保存，之后接着处理';
    } else if (queued.length) {
      thread.status = 'queued';
      thread.summary = queued.length > 1 || thread.runs.length > 1 ? '补充已保存，会按顺序接着处理' : '等待开始';
    } else if (thread.runs.length) thread.status = thread.runs.at(-1).status;
  }

  createThread(input) {
    const thread = {
      id: id('thr'), title: input.text.split('\n')[0].slice(0, 60) || '整理资料',
      status: 'queued', summary: '等待开始', createdAt: now(), updatedAt: now(),
      messages: [], runs: [], artifacts: [], decisions: [], events: [], memoryIds: input.memoryIds || [],
    };
    this.appendRun(thread, input);
    return this.put('thread', thread);
  }

  appendRun(thread, input) {
    if (thread.runs.some((run) => (thread.kind !== 'group' || run.contactId === input.contactId) && (this.unresolved(run) || run.requiresReconciliation))) {
      throw new APIError(409, 'unknown_execution', '原任务执行结果尚未确认，请先核查，补充内容不会重新提交该操作');
    }
    const pending = thread.runs.filter((run) => run.status === 'needs_input' && (thread.kind !== 'group' || run.contactId === input.contactId));
    if (!input.preservePending && (!input.reuseMessageId || (thread.kind === 'group' && input.contactId))) for (const previous of pending) {
      previous.status = 'cancelled'; previous.finishedAt = now(); previous.cancellationReason = '用户补充了要求，旧预览已失效';
      for (const decision of thread.decisions.filter((item) => item.runId === previous.id && item.state === 'pending')) {
        decision.state = 'cancelled'; decision.version += 1; decision.cancellationReason = previous.cancellationReason;
      }
      this.event(thread, 'cancelled', previous.cancellationReason, { runId: previous.id });
    }
    const message = input.reuseMessageId ? thread.messages.find((item) => item.id === input.reuseMessageId) : {
      id: id('msg'), role: 'user', text: input.text, createdAt: now(),
      attachments: (input.attachments || []).map((item) => ({ id: id('att'), name: item.name, text: item.text, size: Buffer.byteLength(item.text) })),
    };
    if (!input.reuseMessageId) thread.messages.push(message);
    const run = { id: id('run'), status: 'queued', mode: input.mode || 'codex', connectionId: input.connectionId || null,
      localAgentId: input.localAgentId || 'codex',
      ...(input.executionSnapshot ? { executionSnapshot: structuredClone(input.executionSnapshot) } : {}),
      ...(input.resourceLinksSnapshot ? { resourceLinksSnapshot: structuredClone(input.resourceLinksSnapshot) } : {}),
      ...(input.projectSnapshot ? { projectSnapshot: structuredClone(input.projectSnapshot) } : {}),
      ...(input.sharedGroup ? { sharedGroup: structuredClone(input.sharedGroup) } : {}),
      ...(input.groupOrigin ? { groupOrigin: structuredClone(input.groupOrigin) } : {}),
      ...(input.contactId ? { contactId: input.contactId, contactSnapshot: input.contactSnapshot,
        participantSnapshot: input.participantSnapshot, conversationSnapshot: input.conversationSnapshot, visibleAfterMessageId: input.visibleAfterMessageId,
        responsePolicy: input.responsePolicy, imPolicy: input.imPolicy, participantMemberships: input.participantMemberships } : {}),
      messageId: message.id, memoryIds: input.memoryIds || thread.memoryIds || [], createdAt: now(),
      action: input.action || null, phase: 'prepare', deliveryState: 'not_sent', actionState: 'not_started', verificationState: 'not_started' };
    if (input.contactId && input.contactSnapshot && run.mode === 'connection') {
      const connection = this.require('connection', run.connectionId);
      if (connection.type === 'a2a') {
        // This record is private: accepting Send binds chat to this exact transport,
        // without inventing an approval or exposing credential references to the UI.
        const binding = input.connectionIdentityId ? this.get('message_identity', input.connectionIdentityId) : connectionIdentity(connection);
        if (binding) this.put('message_identity', { ...binding, id: run.id });
      }
    }
    thread.runs.push(run);
    thread.status = 'queued'; thread.summary = '等待开始'; thread.updatedAt = now();
    this.event(thread, 'queued', run.mode === 'local' ? '已排队：本地整理，无需模型' : '任务已排队', { runId: run.id });
    this.refreshThread(thread);
    return run;
  }

  saveArtifact(threadId, runId, title, body, source) {
    body = this.vault.redactString(body);
    const artifact = { id: id('art'), threadId, runId, title, mimeType: 'text/markdown', size: Buffer.byteLength(body),
      sha256: digest(body), createdAt: now(), source, body };
    this.put('artifact', artifact);
    const readback = this.require('artifact', artifact.id);
    if (digest(readback.body) !== artifact.sha256) throw new Error('Artifact readback mismatch');
    artifact.verifiedAt = now();
    this.put('artifact', artifact);
    const { body: _body, ...metadata } = artifact;
    return metadata;
  }

  recover() {
    for (const thread of this.list('thread')) {
      let changed = false;
      for (const run of thread.runs) {
        if (!['running', 'verifying'].includes(run.status) && !run.cancelPending) continue;
        const unclaimed = thread.decisions.find(item => item.runId === run.id && !['provider_approval', 'chat_action'].includes(item.kind) && item.state === 'decided' && item.decision?.choice === 'approve');
        if (run.mode === 'connection' && run.remoteToolRound > 0 && run.remoteToolResults?.length === run.remoteToolRound
          && run.remoteRounds?.length === run.remoteToolRound && run.phase === 'prepare' && run.deliveryState === 'not_sent'
          && !run.externalTaskId && !run.cancelPending && !run.stopUnconfirmed && !run.requiresReconciliation) {
          run.status = 'queued'; delete run.finishedAt; delete run.error;
          this.event(thread, 'recovery', '恢复尚未派发的工具后续轮次', { runId: run.id }); changed = true; continue;
        }
        if (run.mode === 'connection' && !run.cancelPending && !run.stopUnconfirmed && !run.requiresReconciliation
          && unclaimed?.deliveryState === 'not_sent' && this.get('decision_identity', unclaimed.id)?.payloadHash
          && !this.get('decision_attempt', run.id) && !run.externalTaskId
          && (!run.deliveryState || run.deliveryState === 'not_sent') && (!run.actionState || run.actionState === 'not_started')) {
          run.status = 'queued'; run.phase = 'prepare'; delete run.finishedAt; delete run.error;
          this.event(thread, 'recovery', '原操作尚未派发，恢复排队并重新核对授权', { runId: run.id }); changed = true; continue;
        }
        if (run.cancelPending || run.sharedGroup && run.mode === 'codex') { run.stopUnconfirmed = true; run.requiresReconciliation = true; run.cancelPending = false; }
        run.status = run.mode === 'local' ? 'blocked' : 'unknown';
        run.error = run.mode === 'local' ? '服务重启中断了本地整理，可重试' : '服务重启时任务尚未确认结果；先核查，避免重复执行';
        run.finishedAt = now();
        if (run.deliveryState === 'sending') run.deliveryState = 'unknown';
        if (run.actionState === 'running') run.actionState = 'unknown';
        thread.status = run.status; thread.summary = run.error;
        const decision = thread.decisions.find((item) => item.runId === run.id && !['provider_approval', 'chat_action'].includes(item.kind) && item.state === 'decided');
        if (decision) {
          decision.deliveryState = run.deliveryState;
          decision.actionState = run.actionState;
          decision.verificationState = 'unknown';
        }
        this.event(thread, 'recovery', run.error, { runId: run.id });
        changed = true;
      }
      if (changed) { this.refreshThread(thread); thread.updatedAt = now(); this.put('thread', thread); }
    }
  }

  close() {
    if (!this.db) return;
    this.vault?.close();
    this.db.close(); this.db = null;
    this.lockDb.close(); this.lockDb = null;
  }
}
