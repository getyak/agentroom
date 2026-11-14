import { PI_CONVERSATION_VERSION, piBindingFingerprint, validatePiSession, inspectPiTurn } from './conversation-pi.mjs';
import { digest } from './store.mjs';
import { executeACP } from './acp-client.mjs';
import { StringDecoder } from 'node:string_decoder';
import { piThinkingLevels, readAgentProfile, resolveExecution } from './agent-profiles.mjs';
import { codexQuota } from './agent-info.mjs';
import { spawn as nativeSpawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Server-only adapters. Never pass renderer input into deps, commands or env.
// Auth status means local login configuration, not account ownership or quota.
// Claude flags/auth JSON: https://code.claude.com/docs/en/cli-reference
// --safe-mode keeps authentication/model selection while disabling customizations.
const CATALOG = Object.freeze([
  { id: 'codex', name: 'Codex', setupUrl: 'https://developers.openai.com/codex/cli/', loginCommandId: 'codex-login' },
  { id: 'claude', name: 'Claude Code', setupUrl: 'https://code.claude.com/docs/en/setup', loginCommandId: 'claude-login' },
  { id: 'pi', name: 'Pi', setupUrl: 'https://pi.dev/', loginCommandId: null },
  { id: 'gemini', name: 'Gemini CLI', setupUrl: 'https://geminicli.com/docs/get-started/installation/', loginCommandId: null },
  { id: 'opencode', name: 'OpenCode', setupUrl: 'https://opencode.ai/docs/', loginCommandId: null },
]);
export const LOCAL_AGENT_IDS = Object.freeze(CATALOG.map(({ id }) => id));
const AUTH_METHODS = new Set(['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party']);
const MESSAGES = Object.freeze({
  unknown_agent: '不支持这个本机助手标识。',
  invalid_input: '本机助手需要非空提示词和有效的独立工作目录。',
  not_installed: '没有找到这个本机助手。请按官方说明安装后重新检查。',
  authentication_required: '这个本机助手尚未登录，请在本机完成登录后重新检查。',
  authentication_unknown: '尚不能确认这个本机助手的登录配置，请在本机检查后重试。',
  execution_unsupported: '已识别这个助手，但本版本尚未支持可靠的受控执行；没有调用模型。',
  unsupported_cli_version: '当前 CLI 缺少受控执行所需选项，请更新官方 CLI 后重新检查；没有调用模型。',
  guest_configuration_unsupported: '访客模式暂不支持这个 Codex 提供商配置；没有切换提供商。可选择兼容的本机 Agent。',
  cancelled: '本次本机助手执行已取消。',
  timeout: '本机助手超过运行时限，结果未确认；没有切换模型或提供商。',
  output_limit: '本机助手输出超过上限，结果未确认。',
  spawn_failed: '本机助手无法启动，请检查本机安装与执行权限。',
  stop_unconfirmed: '本机助手停止尚未确认，请核查本次本机进程；未保存成功结果。',
  provider_limit: '当前助手的提供商额度或速率限制阻止了执行；没有切换提供商。',
  provider_authentication_failed: '当前模型的提供商拒绝了认证，请在 Pi 中修复登录或 API Key，再重新读取配置；没有切换提供商。',
  model_unavailable: '当前模型不可用，请重新读取本机配置或在联系人中选择模型；没有切换提供商。',
  model_mismatch: '助手返回的模型与这次指定的模型不一致，未将结果标记为完成。',
  execution_failed: '本机助手没有返回成功的结构化文档结果，请核查 CLI 登录与配置。',
});
export class LocalAgentError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.execution_failed);
    this.name = 'LocalAgentError'; this.code = Object.hasOwn(MESSAGES, code) ? code : 'execution_failed';
    this.status = ['unknown_agent', 'invalid_input'].includes(this.code) ? 400 : 503;
  }
}
const supported = (id) => id === 'codex' || id === 'claude' || id === 'pi';
// --no-context-files excludes AGENTS but Pi still discovers global SYSTEM files.
// Explicit prompt sources prevent those files from changing accepted personas.
const PI_PROMPT_ARGS = ['--system-prompt', 'You are an AgentRoom personal assistant. Follow the supplied task and the accepted agentIdentity persona. Use only the supplied conversation. Do not access unrelated data, invoke tools, change providers or claim external actions.', '--append-system-prompt', ''];
const definition = (id) => {
  const agent = CATALOG.find((item) => item.id === id);
  if (!agent) throw new LocalAgentError('unknown_agent');
  return agent;
};
const limit = (value, fallback, maximum) => Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : fallback;
function options(deps) {
  return { ...deps, spawn: deps.spawn || nativeSpawn, env: deps.env || process.env, home: deps.home ?? homedir(),
    now: deps.now || Date.now,
    probeTimeoutMs: limit(deps.probeTimeoutMs, 5000, 10_000),
    executionTimeoutMs: limit(deps.executionTimeoutMs, 300_000, 600_000),
    maxProbeBytes: limit(deps.maxProbeBytes, 16_384, 65_536),
    maxOutputBytes: limit(deps.maxOutputBytes, 2_000_000, 4_000_000),
    killGraceMs: limit(deps.killGraceMs, 300, 1500),
    cacheTtlMs: limit(deps.cacheTtlMs, 15_000, 60_000) };
}

async function executableFor(agent, deps) {
  // An explicit server command override is authoritative, including a missing
  // test command: never fall back to the user's working CLI in that case.
  const command = Object.hasOwn(deps.commands || {}, agent.id) ? deps.commands[agent.id] : agent.id;
  if (typeof command !== 'string' || !command || command.includes('\0')) return null;
  const directories = [...new Set([...(deps.env.PATH || '').split(delimiter).filter(isAbsolute),
    join(deps.home, '.local/bin'), join(deps.home, 'bin'), join(deps.home, 'Library/pnpm'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])];
  const candidates = command.includes('/') || command.includes('\\') ? [resolve(command)] : directories.map((directory) => join(directory, command));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; }
    catch { /* A missing/inaccessible candidate cannot supply an executable. */ }
  }
  return null;
}

// Private bounded capture; only parsed whitelisted values leave this module.
function run(command, args, deps, { cwd, input = '', signal, probe = false, onLine, responseId, piCapture = false, onSpawn } = {}) {
  if (signal?.aborted) return Promise.reject(new LocalAgentError('cancelled'));
  return new Promise((resolveRun, reject) => {
    let child, deadline, escalation, reaping, closed = false, failure = null;
    let stdoutBytes = 0, stderrBytes = 0;
    const decoder = new StringDecoder('utf8'); let framed = '';
    const stdout = [], stderr = [], cap = probe ? deps.maxProbeBytes : deps.maxOutputBytes;
    // Pi repeats messages/tool results in turn_end/agent_end. Stream those
    // records without retaining them; only the last authoritative assistant
    // text/error and settled marker are needed (pi docs/json.md). The answer
    // and each JSON line retain cap; total transport has an 8x hard bound.
    let piMessage, piSettled = false;
    const lineReceived = line => {
      if (piCapture && Buffer.byteLength(line) > cap) { stop('output_limit'); return; }
      try { onLine?.(line, data => child.stdin.write(data)); if (responseId && JSON.parse(line)?.id === responseId) child.stdin.end(); } catch {}
      if (piCapture) {
        let event; try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'agent_settled') piSettled = true;
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const message = event.message;
          piMessage = { role: 'assistant', provider: message.provider, model: message.model, stopReason: message.stopReason, errorMessage: message.errorMessage,
            content: Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(({ text }) => ({ type: 'text', text })) : [] };
        }
      }
    };
    const deliver = chunk => {
      framed += chunk; let at;
      while (!failure && (at = framed.indexOf('\n')) >= 0) { const line = framed.slice(0, at); framed = framed.slice(at + 1); lineReceived(line); }
      if (piCapture && Buffer.byteLength(framed) > cap) stop('output_limit');
    };
    const cleanup = () => {
      clearTimeout(deadline); clearTimeout(escalation); clearTimeout(reaping);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (code) => {
      if (closed) return;
      if ((onLine || responseId || piCapture) && !failure) { deliver(decoder.end()); if (!failure && framed.trim()) lineReceived(framed); }
      closed = true; cleanup();
      if (failure) reject(new LocalAgentError(failure));
      else resolveRun({ code, stdout: piCapture ? (piMessage ? JSON.stringify({ type: 'message_end', message: piMessage }) + '\n' : '') + (piSettled ? JSON.stringify({ type: 'agent_settled' }) : '') : Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const kill = (kind) => {
      if (!child || closed) return;
      try {
        if (child.pid && process.platform !== 'win32') (deps.kill || process.kill)(-child.pid, kind);
        else child.kill(kind);
      } catch { try { child.kill(kind); } catch { /* Only this owned child may be signaled. */ } }
    };
    const stop = (reason) => {
      if (closed || failure) return;
      failure = reason;
      kill('SIGTERM');
      if (closed) return;
      escalation = setTimeout(() => {
        kill('SIGKILL');
        if (!closed) reaping = setTimeout(() => { failure = 'stop_unconfirmed'; finish(null); }, 1000);
      }, deps.killGraceMs);
    };
    const abort = () => stop('cancelled');
    try {
      child = deps.spawn(command, args, { cwd, env: deps.env, shell: false, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch { failure = 'spawn_failed'; finish(null); return; }
    child.once('error', () => { failure ||= 'spawn_failed'; });
    child.once('close', finish);
    child.stdout.on('data', (chunk) => {
      if (closed || failure) return;
      const bytes = Buffer.from(chunk); stdoutBytes += bytes.length;
      if (stdoutBytes + (probe ? stderrBytes : 0) > (piCapture ? cap * 8 : cap)) { stop('output_limit'); return; }
      if (!piCapture) stdout.push(bytes);
      if (onLine || responseId || piCapture) deliver(decoder.write(bytes));
    });
    child.stderr.on('data', (chunk) => {
      if (closed || failure) return;
      const bytes = Buffer.from(chunk);
      if (probe) {
        stderrBytes += bytes.length;
        if (stdoutBytes + stderrBytes > cap) { stop('output_limit'); return; }
        stderr.push(bytes);
      } else if (stderrBytes < 16_384) {
        const bounded = bytes.subarray(0, 16_384 - stderrBytes); stderrBytes += bounded.length; stderr.push(bounded);
      }
    });
    child.stdin.on('error', () => {});
    try { onSpawn?.({ pid: child.pid }); } catch { stop('spawn_failed'); }
    signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => stop('timeout'), probe ? deps.probeTimeoutMs : deps.executionTimeoutMs);
    if (failure) child.stdin.end(); else if (responseId) child.stdin.write(input); else child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}

const versionOf = (text) => text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,4}\b/)?.[0] || null;
async function probe(command, args, deps, signal) {
  try { return await run(command, args, deps, { probe: true, signal, cwd: deps.home }); }
  catch (error) { if (error.code === 'cancelled') throw error; return null; }
}
async function authentication(agent, command, deps, signal) {
  if (!supported(agent.id)) return { status: 'unsupported' };
  if (agent.id === 'pi') {
    let result;
    try { result = await run(command, ['--mode', 'rpc', '--no-session', '--no-tools', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', ...PI_PROMPT_ARGS], { ...deps, maxProbeBytes: 2_000_000 }, { probe: true, signal, cwd: deps.home, responseId: 'agentstudio-models', input: JSON.stringify({ id: 'agentstudio-models', type: 'get_available_models' }) + '\n' }); }
    catch (error) { if (error.code === 'cancelled') throw error; }
    // RPC metadata can contain transport headers. Project only these fields;
    // never expose or persist the raw response, credentials or API addresses.
    deps.piModels = [];
    if (result?.code === 0) for (const line of result.stdout.split('\n')) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.id !== 'agentstudio-models' || event.success !== true || !Array.isArray(event.data?.models)) continue;
      for (const model of event.data.models.slice(0, 1000)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(model.provider || '') || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,159}$/.test(model.id || '')) continue;
        const thinkingLevels = piThinkingLevels(model);
        deps.piModels.push({ provider: model.provider, id: model.id, name: typeof model.name === 'string' ? model.name.slice(0, 100) : model.id, reasoning: model.reasoning === true, images: Array.isArray(model.input) && model.input.includes('image'), thinkingLevels });
      }
    }
    return { status: deps.piModels.length ? 'configured' : 'unknown' };
  }
  const result = await probe(command, agent.id === 'codex' ? ['login', 'status'] : ['auth', 'status'], deps, signal);
  if (!result) return { status: 'unknown' };
  if (agent.id === 'codex') {
    if (result.code === 0) return { status: 'configured' };
    return { status: result.code === 1 && /not logged in|logged out|not authenticated/i.test(result.stdout + result.stderr) ? 'required' : 'unknown' };
  }
  try {
    const auth = JSON.parse(result.stdout);
    const method = AUTH_METHODS.has(auth?.authMethod) ? { method: auth.authMethod } : {};
    if (auth?.loggedIn === true && result.code === 0) return { status: 'configured', ...method };
    if (auth?.loggedIn === false && [0, 1].includes(result.code)) return { status: 'required', ...method };
  } catch { /* Malformed or unexpected auth data remains unknown, never raw text. */ }
  return { status: 'unknown' };
}

const caches = new WeakMap();
const quotaCaches = new WeakMap();
async function accountQuota(agent, command, profile, auth, deps) {
  if (auth.status !== 'configured') return { status: 'unavailable', reason: 'login_required' };
  if (agent.id !== 'codex') return { status: 'unavailable', reason: 'not_supported' };
  if (profile.defaults.provider !== 'openai') return { status: 'unavailable', reason: 'provider_managed' };
  let cache = quotaCaches.get(deps.spawn);
  if (!cache) { cache = new Map(); quotaCaches.set(deps.spawn, cache); }
  const key = JSON.stringify([command, deps.home, deps.env.CODEX_HOME || '']);
  const previous = cache.get(key);
  if (previous?.expires > deps.now()) return previous.value;
  const pending = (async () => {
    const checkedAt = new Date(deps.now()).toISOString();
    try {
      let quota;
      const result = await run(command, ['app-server'], deps, { probe: true, cwd: deps.home, responseId: 'agentroom-quota',
        input: JSON.stringify({ id: 'agentroom-init', method: 'initialize', params: { clientInfo: { name: 'agentroom', version: '1' }, capabilities: null } }) + '\n',
        onLine(line, write) {
          let message; try { message = JSON.parse(line); } catch { return; }
          if (message.id === 'agentroom-init' && message.result) write(JSON.stringify({ method: 'initialized' }) + '\n' + JSON.stringify({ id: 'agentroom-quota', method: 'account/rateLimits/read' }) + '\n');
          if (message.id === 'agentroom-quota' && message.result) quota = codexQuota(message.result, checkedAt);
        } });
      return result.code === 0 && quota ? quota : { status: 'unavailable', reason: 'read_failed', checkedAt };
    } catch { return { status: 'unavailable', reason: 'read_failed', checkedAt }; }
  })();
  cache.set(key, { expires: deps.now() + 60_000, value: pending });
  return pending;
}
export async function discoverLocalAgents({ force = false, deps: injected = {} } = {}) {
  const deps = options(injected);
  let cache = caches.get(deps.spawn);
  if (!cache) { cache = new Map(); caches.set(deps.spawn, cache); }
  const profiles = await Promise.all(CATALOG.map(agent => readAgentProfile(agent.id, deps)));
  const key = JSON.stringify([profiles.map(profile => profile.version), deps.home, deps.env.PATH || '', LOCAL_AGENT_IDS.map((id) => deps.commands?.[id] ?? null)]);
  const previous = cache.get(key);
  if (!force && previous?.pending) return structuredClone(await previous.pending);
  if (!force && previous && previous.expires > deps.now()) return structuredClone(previous.value);
  const entry = {};
  cache.set(key, entry);
  const pending = (async () => {
    const agents = Array(CATALOG.length); let cursor = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (cursor < CATALOG.length) {
        const index = cursor++, agent = CATALOG[index], command = await executableFor(agent, deps);
        const version = command ? await probe(command, ['--version'], deps) : null;
        const auth = command ? await authentication(agent, command, deps) : { status: 'required' };
        const profile = profiles[index];
        if (agent.id === 'pi' && command) { profile.models = deps.piModels || []; profile.providers = [...new Set(profile.models.map(model => model.provider))]; }
        const quota = command ? await accountQuota(agent, command, profile, auth, deps) : { status: 'unavailable', reason: 'login_required' };
        agents[index] = { ...agent, profile, quota, installed: Boolean(command), version: version?.code === 0 ? versionOf(version.stdout + version.stderr) : null,
          auth,
          execution: { supported: supported(agent.id), ...(!supported(agent.id) ? { reason: MESSAGES.execution_unsupported } : {}) } };
      }
    }));
    const value = { checkedAt: new Date(deps.now()).toISOString(), agents };
    entry.value = value; entry.expires = deps.now() + deps.cacheTtlMs;
    return value;
  })();
  entry.pending = pending;
  try { return structuredClone(await pending); }
  finally {
    delete entry.pending;
    if (!entry.value) cache.delete(key);
    if (cache.size > 16) for (const [oldKey, item] of cache) if (oldKey !== key && !item.pending) { cache.delete(oldKey); break; }
  }
}

function finalMarkdown(id, result, selection) {
  if (result.code !== 0) {
    if (/quota|usage.limit|insufficient|billing|credits|rate.limit|429/i.test(result.stderr + result.stdout)) throw new LocalAgentError('provider_limit');
    throw new LocalAgentError('execution_failed');
  }
  if (id === 'pi') {
    let message, settled = false;
    for (const line of result.stdout.split('\n')) { let event; try { event = JSON.parse(line); } catch { continue; } if (event.type === 'message_end' && event.message?.role === 'assistant') message = event.message; if (event.type === 'agent_settled') settled = true; }
    if (!settled || message?.stopReason !== 'stop') {
      if (/401|403|invalid.?api.?key|invalid.?authentication|unauthori[sz]ed|authentication.failed/i.test(message?.errorMessage || '')) throw new LocalAgentError('provider_authentication_failed');
      if (/quota|rate.limit|429|billing|credits/i.test(message?.errorMessage || '')) throw new LocalAgentError('provider_limit');
      if (/model.*(?:not found|unsupported|unavailable)|404/i.test(message?.errorMessage || '')) throw new LocalAgentError('model_unavailable');
      throw new LocalAgentError('execution_failed');
    }
    if (message.provider !== selection.provider || message.model !== selection.model) throw new LocalAgentError('model_mismatch');
    const text = message.content?.filter(block => block.type === 'text').map(block => block.text || '').join('\n');
    if (text?.trim()) return text;
    throw new LocalAgentError('execution_failed');
  }
  if (id === 'claude') {
    try {
      let event; try { event = JSON.parse(result.stdout); } catch { event = result.stdout.split('\n').flatMap(line => { try { const item = JSON.parse(line); return item.type === 'result' ? [item] : []; } catch { return []; } }).at(-1); }
      if (event?.type === 'result' && event.subtype === 'success' && event.is_error === false && typeof event.result === 'string' && event.result.trim()) return event.result;
    } catch { /* Only the successful result event is a document. */ }
  } else {
    let markdown = '', completed = false, failed = false;
    for (const line of result.stdout.split('\n')) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') markdown = event.item.text;
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed' || event.type === 'error') failed = true;
    }
    if (completed && !failed && markdown.trim()) return markdown;
  }
  throw new LocalAgentError('execution_failed');
}

export async function conversationPiCapability({ deps: injected = {}, executionSnapshot } = {}) {
  const deps=options(injected),runtime=executionSnapshot?.runtime || await deps.assistantManager?.launch('pi');
  if(runtime && runtime.protocol!=='cli')return null;
  if(runtime?.command)deps.commands={...deps.commands,pi:runtime.command};
  const command=await executableFor(definition('pi'),deps);if(!command)return null;
  const version=await probe(command,['--version'],deps);
  if(version?.code!==0 || versionOf(version.stdout + version.stderr)!==PI_CONVERSATION_VERSION)return null;
  const fingerprint=await piBindingFingerprint(deps);if(!fingerprint)return null;
  const info=await stat(command);
  return {id:'pi',version:PI_CONVERSATION_VERSION,bindingFingerprint:digest(JSON.stringify({command,dev:info.dev,ino:info.ino,mtime:info.mtimeMs,size:info.size,fingerprint}))};
}

export async function executeLocalAgent({ id, prompt, workspace, signal, onEvent, onProcess, executionSnapshot, toolSession, conversationSession, isolateUserContext = false, deps: injected = {} } = {}) {
  const deps = options(injected);
  const runtime = executionSnapshot?.runtime || await deps.assistantManager?.launch(id);
  if (runtime?.protocol === 'acp') {
    if (isolateUserContext || toolSession || conversationSession) throw new LocalAgentError('guest_configuration_unsupported');
    return executeACP({ launch: runtime, prompt, workspace, signal, onEvent, onProcess, env: deps.env, spawn: deps.spawn, timeoutMs: deps.executionTimeoutMs, maxBytes: deps.maxOutputBytes });
  }
  const agent = definition(id);
  if (runtime?.protocol === 'cli' && isAbsolute(runtime.command || '')) deps.commands = { ...deps.commands, [id]: runtime.command };
  if (isolateUserContext && id === 'codex') {
    const allowed = new Set(['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
    deps.env = Object.fromEntries(Object.entries(deps.env).filter(([name]) => allowed.has(name)));
  }
  if (signal?.aborted) throw new LocalAgentError('cancelled');
  if (!supported(id)) throw new LocalAgentError('execution_unsupported');
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 2_000_000 || typeof workspace !== 'string' || !isAbsolute(workspace)) throw new LocalAgentError('invalid_input');
  try { if (!(await stat(workspace)).isDirectory()) throw new Error(); }
  catch { throw new LocalAgentError('invalid_input'); }
  const command = await executableFor(agent, deps);
  if (!command) throw new LocalAgentError('not_installed');
  let version;
  if (isolateUserContext && id === 'codex') { version = await probe(command, ['--version'], deps, signal); if (version?.code !== 0 || versionOf(version.stdout + version.stderr) !== '0.163.0') throw new LocalAgentError('unsupported_cli_version'); }
  const auth = await authentication(agent, command, deps, signal);
  if (auth.status !== 'configured') throw new LocalAgentError(auth.status === 'required' ? 'authentication_required' : 'authentication_unknown');
  version ||= await probe(command, ['--version'], deps, signal);
  const profile = await readAgentProfile(id, deps);
  if (isolateUserContext && id === 'codex' && (!toolSession || executionSnapshot?.provider !== 'openai' || profile.guestCompatible === false)) throw new LocalAgentError('guest_configuration_unsupported');
  if (id === 'pi') { profile.models = deps.piModels || []; profile.providers = [...new Set(profile.models.map(model => model.provider))]; }
  let selection = executionSnapshot;
  if (id === 'pi') {
    try { selection = resolveExecution(profile, selection ? { modelMode: 'fixed', provider: selection.provider, model: selection.model, thinking: selection.thinking || 'follow' } : {}); } catch { throw new LocalAgentError('model_unavailable'); }
  }
  let args, claudeHelp;
  if (id === 'codex') args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', workspace, '-'];
  else if (id === 'pi') args = ['--mode', 'json', '--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline', ...PI_PROMPT_ARGS, '--provider', selection.provider, '--model', selection.model, '--thinking', selection.thinking];
  else {
    const help = await probe(command, ['--help'], { ...deps, maxProbeBytes: 65_536 }, signal);
    claudeHelp = help;
    const flags = ['--safe-mode', '--print', '--input-format', '--output-format', '--tools', '--strict-mcp-config', '--mcp-config',
      '--disallowedTools', '--permission-mode', '--disable-slash-commands', '--no-session-persistence', '--settings'];
    if (!help || help.code !== 0 || flags.some((flag) => !help.stdout.includes(flag))) throw new LocalAgentError('unsupported_cli_version');
    args = ['--safe-mode', '--print', '--input-format', 'text', '--output-format', 'json', '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', 'mcp__*',
      '--permission-mode', 'plan', '--disable-slash-commands', '--no-session-persistence', '--settings', '{"disableAllHooks":true}'];
    if (help.stdout.includes('--include-partial-messages') && help.stdout.includes('--verbose')) { args[args.indexOf('--output-format') + 1] = 'stream-json'; args.push('--verbose', '--include-partial-messages'); }
    if (selection?.model) { if (!help.stdout.includes('--model')) throw new LocalAgentError('unsupported_cli_version'); args.push('--model', selection.model); }
    if (selection?.thinking) { if (!help.stdout.includes('--effort')) throw new LocalAgentError('unsupported_cli_version'); args.push('--effort', selection.thinking); }
  }
  if (id === 'codex' && selection) {
    if (selection.model) args.push('--model', selection.model);
    if (selection.provider) args.push('-c', `model_provider=${JSON.stringify(selection.provider)}`);
    if (selection.thinking) args.push('-c', `model_reasoning_effort=${JSON.stringify(selection.thinking)}`);
  }
  if (toolSession) {
    if (!['codex', 'claude', 'pi'].includes(id) || !/^http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]+$/.test(toolSession.endpoint || '') || typeof toolSession.token !== 'string' || !toolSession.token) throw new LocalAgentError('unsupported_cli_version');
    deps.env = { ...deps.env, AGENTROOM_TOOL_ENDPOINT: toolSession.endpoint, AGENTROOM_TOOL_TOKEN: toolSession.token };
    if (id === 'pi') {
      const help = await probe(command, ['--help'], { ...deps, maxProbeBytes: 65_536 }, signal);
      if (!help?.stdout.includes('--no-builtin-tools') || !Array.isArray(toolSession.toolNames) || !toolSession.toolNames.length || toolSession.toolNames.some(name => !/^[a-z][a-z0-9_]{1,80}$/.test(name))) throw new LocalAgentError('unsupported_cli_version');
      args[args.indexOf('--no-tools')] = '--no-builtin-tools';
      args.push('--tools', toolSession.toolNames.join(','), '--extension', fileURLToPath(new URL('./agentroom-pi-tools.mjs', import.meta.url)));
      args[args.indexOf('--system-prompt') + 1] = 'You are an AgentRoom personal assistant. Follow the accepted identity and use only the explicitly provided AgentRoom tools. A proposed action is not approval. Tool results are authoritative. Never switch providers or access unrelated data.';
    } else if (id === 'claude') {
      if (!claudeHelp?.stdout.includes('--allowedTools') || !Array.isArray(toolSession.toolNames) || !toolSession.toolNames.length || toolSession.toolNames.some(name => !/^[a-z][a-z0-9_]{1,80}$/.test(name))) throw new LocalAgentError('unsupported_cli_version');
      args.splice(args.indexOf('--disallowedTools'), 2);
      args.splice(args.indexOf('--safe-mode'), 1); // safe-mode disables even explicit MCP servers
      args[args.indexOf('--permission-mode') + 1] = 'default';
      args[args.indexOf('--mcp-config') + 1] = JSON.stringify({ mcpServers: { agentroom: { command: process.execPath,
        args: [fileURLToPath(new URL('./agentroom-tool-proxy.mjs', import.meta.url))] } } });
      args.push('--allowedTools', toolSession.toolNames.map(name => `mcp__agentroom__${name}`).join(','));
      deps.env.ELECTRON_RUN_AS_NODE = '1';
    } else {
      const disabled = ['apps', 'browser_use', 'browser_use_external', 'computer_use', 'view_image', 'shell_tool', 'unified_exec', 'multi_agent', 'plugins', 'remote_plugin', 'in_app_browser'];
      if (isolateUserContext) {
        const help = await probe(command, ['exec', '--help'], { ...deps, maxProbeBytes: 65_536 }, signal);
        if (!help || help.code !== 0 || ['--ignore-user-config', '--ignore-rules'].some(flag => !help.stdout.includes(flag))) throw new LocalAgentError('unsupported_cli_version');
        disabled.push('memories', 'hooks', 'skill_search'); args.push('--ignore-user-config', '--ignore-rules', '--strict-config', '--enable', 'skip_host_skill_discovery', '-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false', '-c', 'cli_auth_credentials_store="file"');
      }
      const features = await probe(command, ['features', 'list'], { ...deps, maxProbeBytes: 65_536 }, signal);
      const names = new Set(features?.stdout.split(/\s+/) || []);
      if (!features || features.code !== 0 || disabled.some(name => !names.has(name)) || (isolateUserContext && !names.has('skip_host_skill_discovery'))) throw new LocalAgentError('unsupported_cli_version');
      // Inventory the effective restricted configuration. App-injected servers
      // disappear when disabled; overriding their absent tables creates invalid stubs.
      const inventory = await probe(command, ['mcp', 'list', '--json', ...disabled.flatMap(feature => ['--disable', feature])], { ...deps, maxProbeBytes: 65_536 }, signal);
      let servers;
      try { servers = JSON.parse(inventory?.stdout); } catch { throw new LocalAgentError('unsupported_cli_version'); }
      if (!Array.isArray(servers) || servers.some(server => typeof server.name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(server.name))) throw new LocalAgentError('unsupported_cli_version');
      for (const server of servers) args.push('-c', `mcp_servers.${server.name}.enabled=false`);
      for (const feature of disabled) args.push('--disable', feature);
      args.push('-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
        '-c', 'mcp_servers.agentroom.enabled=true', '-c', 'mcp_servers.agentroom.default_tools_approval_mode="approve"', '-c', `mcp_servers.agentroom.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.agentroom.args=${JSON.stringify([fileURLToPath(new URL('./agentroom-tool-proxy.mjs', import.meta.url))])}`,
        '-c', 'mcp_servers.agentroom.env_vars=["AGENTROOM_TOOL_ENDPOINT","AGENTROOM_TOOL_TOKEN","ELECTRON_RUN_AS_NODE"]');
      deps.env.ELECTRON_RUN_AS_NODE = '1';
    }
  }
  if(conversationSession) {
    const {session,manifest}=conversationSession;
    const capability=await conversationPiCapability({deps,executionSnapshot});
    if(id!=='pi' || !capability || capability.bindingFingerprint!==session.adapter.bindingFingerprint || workspace!==session.workspace || manifest.promptHash!==digest(prompt))throw new LocalAgentError('unsupported_cli_version');
    const checked=await validatePiSession(session,session.receipt);
    if(!session.receipt || checked.receipt.bytes!==session.receipt.bytes)throw new LocalAgentError('execution_failed');
    manifest.selection={provider:selection.provider,model:selection.model};
    args.splice(args.indexOf('--no-session'),1,'--session',session.file,'--session-dir',session.directory);
    args.push('--extension',fileURLToPath(new URL('./agentroom-pi-receipt.mjs',import.meta.url)));
    deps.env={...deps.env,AGENTROOM_CONVERSATION_RUN:manifest.id,AGENTROOM_CONVERSATION_HASH:manifest.promptHash,AGENTROOM_CONVERSATION_PROVIDER:selection.provider,AGENTROOM_CONVERSATION_MODEL:selection.model};
    conversationSession.beforeDispatch(manifest.selection);
  }
  const identity = { id, name: agent.name, version: version?.code === 0 ? versionOf(version.stdout + version.stderr) : null,
    ...(selection ? { model: selection.model, provider: selection.provider, thinking: selection.thinking } : {}), authentication: 'configured', ...(auth.method ? { authMethod: auth.method } : {}) };
  const emit = (type, data = {}) => { try { onEvent?.({ type, agentId: id, ...data }); } catch { /* Observer failures do not change execution. */ } };
  emit('started');
  const stream = liveEvents(id, emit);
  const result = await run(command, args, deps, { cwd: workspace, input: prompt, signal, onLine: stream, piCapture: id === 'pi', onSpawn: onProcess });
  const markdown = finalMarkdown(id, result, selection);
  let conversationReceipt;
  if(conversationSession){const checked=await inspectPiTurn(conversationSession.session,conversationSession.manifest);if(checked.state!=='completed' || checked.markdown!==markdown)throw new LocalAgentError('execution_failed');conversationReceipt=checked.receipt;}
  emit('completed');
  return { markdown, identity, ...(conversationReceipt ? {conversationReceipt} : {}), verification: { scope: 'cli_document_output', externalEffectsVerified: false } };
}

// Only provider text and coarse phases cross this boundary. Thinking/tool payloads
// remain private, and authoritative final output is checked separately above.
function liveEvents(id, emit) {
  const blocks = new Map();
  const output = () => emit('progress', { phase: 'writing', text: [...blocks].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('') });
  return line => {
    let event; try { event = JSON.parse(line); } catch { return; }
    if (id === 'pi') {
      if (event.type === 'message_start' && event.message?.role === 'assistant') { blocks.clear(); emit('progress', { phase: 'preparing', text: '' }); }
      const update = event.assistantMessageEvent;
      if (event.type === 'message_update' && update?.type?.startsWith('thinking')) { emit('progress', { phase: 'thinking' }); return; }
      if (event.type === 'message_update' && update?.type === 'text_delta' && typeof update.delta === 'string') { const at = update.contentIndex || 0; blocks.set(at, (blocks.get(at) || '') + update.delta); output(); }
      if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.stopReason === 'stop') { blocks.clear(); blocks.set(0, event.message.content?.filter(item => item.type === 'text').map(item => item.text || '').join('\n') || ''); output(); }
    } else if (id === 'codex' && ['item.updated', 'item.completed'].includes(event.type)) {
      if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') { blocks.set(0, event.item.text); output(); }
      else if (event.item?.type === 'reasoning') emit('progress', { phase: 'thinking' });
    } else if (id === 'claude' && event.type === 'stream_event') {
      const update = event.event;
      if (update?.type === 'message_start') blocks.clear();
      if (update?.delta?.type === 'thinking_delta') emit('progress', { phase: 'thinking' });
      if (update?.type === 'content_block_delta' && update.delta?.type === 'text_delta') { const at = update.index || 0; blocks.set(at, (blocks.get(at) || '') + update.delta.text); output(); }
    }
  };
}
