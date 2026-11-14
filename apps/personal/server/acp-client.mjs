import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute } from 'node:path';

// ACP v1 stdio, initialization and prompt lifecycle. No SDK/runtime installed on demand.
// https://agentclientprotocol.com/protocol/v1/transports
// https://agentclientprotocol.com/protocol/v1/prompt-turn
const messages = {
  acp_version_unsupported: '这个助手使用了尚不支持的 ACP 版本，请检查助手或适配器版本。',
  acp_protocol_error: '助手没有返回有效的 ACP 消息，本次结果未确认。',
  acp_disconnected: '助手连接已结束，本次结果未确认。',
  authentication_required: '请先在原助手中完成登录，再回到这里重新检查。已有账号配置没有改动。',
  acp_failed: '助手没有完成这次请求，请检查原助手的登录和配置。',
  acp_empty_output: '助手没有返回可保存的文本回复。',
  acp_output_limit: '助手回复超过限制，本次结果未确认。',
  timeout: '助手响应超时，本次执行已停止。',
  cancelled: '本次助手执行已取消。',
  spawn_failed: '助手没有启动，请检查安装路径和执行权限。',
  stop_unconfirmed: '助手进程停止尚未确认，请核查原任务后再试。',
};
export class ACPError extends Error {
  constructor(code) { super(messages[code] || messages.acp_failed); this.name = 'ACPError'; this.code = code; this.status = 503; }
}
const failure = code => new ACPError(code);
const safeCall = (fn, value) => { try { fn?.(value); } catch { /* Observers do not own transport state. */ } };
const exec = promisify(execFile);

class ACPProcess {
  constructor({ launch, workspace, env = process.env, spawn = nodeSpawn, signal, onProcess, onUpdate, timeoutMs = 300000, maxBytes = 2_000_000 }) {
    if (!launch || !isAbsolute(launch.command || '') || !Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !isAbsolute(workspace || '')) throw failure('spawn_failed');
    if (signal?.aborted) throw failure('cancelled');
    this.pending = new Map(); this.sequence = 0; this.bytes = 0; this.buffer = ''; this.maxBytes = maxBytes; this.onUpdate = onUpdate;
    this.failure = null; this.sessionId = null; this.ended = false; this.stopping = false; this.signal = signal;
    this.closed = new Promise(resolve => { this.closedResolve = resolve; });
    try { this.child = spawn(launch.command, launch.args, { cwd: workspace, env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); }
    catch { throw failure('spawn_failed'); }
    safeCall(onProcess, this.child);
    const decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', chunk => {
      this.bytes += chunk.length;
      if (this.bytes > this.maxBytes) return this.fail(failure('acp_output_limit'));
      this.buffer += decoder.write(chunk);
      let at;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch { this.fail(failure('acp_protocol_error')); return; }
      }
    });
    // Provider stderr can contain login URLs or secrets. It never becomes a user message/log.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => { if (!this.stopping) this.fail(failure('acp_disconnected')); });
    this.child.once('error', () => { this.fail(failure('spawn_failed')); this.ended = true; this.closedResolve(); });
    this.child.once('close', () => {
      this.ended = true; this.closedResolve();
      if (!this.stopping && !this.failure) this.fail(failure('acp_disconnected'));
    });
    this.abort = () => {
      if (this.sessionId) this.send({ method: 'session/cancel', params: { sessionId: this.sessionId } });
      this.fail(failure('cancelled'));
    };
    signal?.addEventListener('abort', this.abort, { once: true });
    this.timer = setTimeout(() => this.fail(failure('timeout')), Math.max(1, Math.min(timeoutMs, 600000))); this.timer.unref();
  }
  send(message) {
    if (this.ended || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ id, method, params }); });
  }
  receive(message) {
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0') throw failure('acp_protocol_error');
    if (typeof message.method === 'string') {
      if (message.method === 'session/update' && message.id === undefined) {
        if (message.params?.sessionId === this.sessionId) this.onUpdate?.(message.params.update);
        return;
      }
      if (message.id !== undefined) {
        if (message.method === 'session/request_permission') {
          const options = message.params?.sessionId === this.sessionId && Array.isArray(message.params?.options) ? message.params.options : [];
          const rejection = options.find(option => option.kind === 'reject_once' && typeof option.optionId === 'string');
          this.onUpdate?.({ sessionUpdate: 'permission_denied' });
          this.send({ id: message.id, result: { outcome: rejection && !this.signal?.aborted ? { outcome: 'selected', optionId: rejection.optionId } : { outcome: 'cancelled' } } });
        } else this.send({ id: message.id, error: { code: -32601, message: 'Client capability is not available' } });
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const text = typeof message.error.message === 'string' ? message.error.message : '';
      pending.reject(failure(/auth|login|sign.?in|credential|unauthori[sz]ed/i.test(text) ? 'authentication_required' : message.error.code === -32800 ? 'cancelled' : 'acp_failed'));
    } else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
    else pending.reject(failure('acp_protocol_error'));
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async initialize() {
    const value = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'agentroom', title: 'AgentRoom', version: '0.2.0' } });
    if (value?.protocolVersion !== 1) throw failure('acp_version_unsupported');
    return value;
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.stopOwnedProcesses();
    return this.closePromise;
  }
  async ownedProcessesAlive() {
    if (!this.child.pid) return false;
    if (process.platform === 'win32') return !this.ended;
    try { process.kill(-this.child.pid, 0); }
    catch (error) { return error.code !== 'ESRCH'; }
    // A leader may exit before a TERM-resistant descendant. Zombies cannot run
    // or receive signals; their reaping is owned by the OS, not this transport.
    try {
      const { stdout } = await exec('ps', ['-axo', 'pid=,pgid=,stat='], { timeout: 1000, maxBuffer: 2_000_000 });
      return stdout.split('\n').some(line => {
        const [, group, state] = line.trim().split(/\s+/);
        return Number(group) === this.child.pid && state && !state.startsWith('Z');
      });
    } catch { return true; }
  }
  async stopOwnedProcesses() {
    this.stopping = true; clearTimeout(this.timer); this.signal?.removeEventListener('abort', this.abort);
    this.fail(failure('acp_disconnected'));
    const stop = kind => { if (!this.child.pid) return; try { process.kill(process.platform === 'win32' ? this.child.pid : -this.child.pid, kind); } catch { if (!this.ended) { try { this.child.kill(kind); } catch {} } } };
    const waitForStop = async duration => {
      const deadline = Date.now() + duration;
      do {
        if (this.ended && !await this.ownedProcessesAlive()) return true;
        await new Promise(resolve => setTimeout(resolve, 40));
      } while (Date.now() < deadline);
      return this.ended && !await this.ownedProcessesAlive();
    };
    if (!this.ended) this.child.stdin.end();
    stop('SIGTERM');
    if (await waitForStop(600)) return;
    stop('SIGKILL');
    if (!await waitForStop(1500)) throw failure('stop_unconfirmed');
  }
}

/** A protocol handshake only: no session/prompt, login flow, credential copy or model request. */
export async function inspectACP(input) {
  const process = new ACPProcess({ ...input, timeoutMs: input.timeoutMs || 8000 });
  try {
    const info = await process.initialize();
    return { protocolVersion: 1, authenticationVerified: false, authMethods: (info.authMethods || []).filter(method => typeof method?.id === 'string').map(method => ({ id: method.id.slice(0, 100), name: typeof method.name === 'string' ? method.name.slice(0, 100) : method.id.slice(0, 100) })) };
  } finally { await process.close(); }
}

/** One owned ACP session per accepted run; history/context remains owned by AgentRoom. */
export async function executeACP(input) {
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 2_000_000) throw failure('acp_protocol_error');
  const parts = new Map(); let anonymous = 0, lastMessage = null, permissionsDenied = 0;
  const emit = event => safeCall(input.onEvent, { type: 'progress', ...event });
  const process = new ACPProcess({ ...input, onUpdate: update => {
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
      const id = update.messageId || lastMessage || `message-${anonymous++}`; lastMessage = id;
      parts.set(id, (parts.get(id) || '') + update.content.text);
      emit({ phase: 'writing', text: [...parts.values()].join('\n\n') });
    } else if (update?.sessionUpdate === 'agent_thought_chunk') emit({ phase: 'thinking' });
    else if (update?.sessionUpdate === 'permission_denied') { permissionsDenied++; emit({ phase: 'preparing', permissionDenied: true }); }
  } });
  try {
    emit({ phase: 'preparing' }); await process.initialize();
    const session = await process.request('session/new', { cwd: input.workspace, mcpServers: [] });
    if (typeof session?.sessionId !== 'string' || !session.sessionId || session.sessionId.length > 2000) throw failure('acp_protocol_error');
    process.sessionId = session.sessionId;
    const pending = process.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: input.prompt }] });
    emit({ phase: 'waiting' }); const result = await pending;
    if (input.signal?.aborted || result?.stopReason === 'cancelled') throw failure('cancelled');
    if (result?.stopReason !== 'end_turn') throw failure(result?.stopReason === 'max_tokens' ? 'acp_output_limit' : 'acp_failed');
    const markdown = [...parts.values()].join('\n\n').trim(); if (!markdown) throw failure('acp_empty_output');
    return { markdown, identity: { agentId: input.launch.agentId, version: input.launch.version || null, protocol: 'acp' }, verification: { scope: 'acp_text_output', externalEffectsVerified: false, permissionsDenied } };
  } finally { await process.close(); }
}
