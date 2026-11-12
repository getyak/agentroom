import { UnreadMessages } from './unread.mjs';
import http from 'node:http';
import { syncNativeServices } from './native-services.mjs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { APIError, PersonalStore, digest, id, now } from './store.mjs';
import { PersonalWorker, codexAvailable, discoverMCP, initializeMCP, rpc } from './runtime.mjs';
import { validateBearerToken } from './vault.mjs';
import { discoverLocalAgents } from './local-agents.mjs';
import { TOOL_PRESETS, inspectAgentCard, integrationURL, presetConnection } from './integrations.mjs';
import { Messenger } from './messenger.mjs';
import { AgentOnboarding } from './agent-onboarding.mjs';
import { WorkspaceGuide, guideContext } from './workspace-guide.mjs';
import { CreationService } from './creation-service.mjs';
import { ArtifactAPI } from './artifact-api.mjs';
import { AgentScheduler } from './agent-scheduler.mjs';
import { RemoteNodes } from './remote-nodes.mjs';
import { DesktopSharing } from './desktop-sharing.mjs';
import { collectHostDiscovery } from './host-discovery.mjs';
import { ProviderApprovals } from './provider-approvals.mjs';
import { readPiIdentity, resolveExecution, watchAgentProfiles } from './agent-profiles.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(appDir, '../..');
const terminal = ['completed', 'failed', 'cancelled', 'blocked', 'unknown'];

function invalid(message) { throw new APIError(400, 'bad_request', message); }

function textValue(value, name, maximum, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > maximum || (!optional && !value.trim())) invalid(`${name} 必须是长度不超过 ${maximum} 的文本`);
  return value.trim();
}

function validateInput(store, body) {
  const text = textValue(body.text, 'text', 30_000, true);
  const mode = body.mode || 'codex';
  if (!['codex', 'local', 'connection'].includes(mode)) invalid('mode 必须是 codex、local 或 connection');
  const localAgentId = body.localAgentId || store.get('setting', 'local-agent')?.agentId || 'codex';
  if (!['codex', 'claude', 'pi'].includes(localAgentId)) invalid('请选择已经支持执行的本机助手');
  if (mode === 'codex' && store.list('thread').some(thread => thread.runs.some(run => run.stopUnconfirmed && (run.localAgentId || 'codex') === localAgentId))) {
    throw new APIError(409, 'local_agent_stop_unconfirmed', '这个助手的停止状态尚未确认，请先核查原任务；新要求没有再次发送');
  }
  if (!Array.isArray(body.attachments ?? []) || (body.attachments?.length || 0) > 20) invalid('每次最多上传 20 份文本资料');
  const attachments = (body.attachments || []).map((item) => {
    const name = textValue(item?.name, '附件名称', 200);
    if (typeof item.text !== 'string' || item.text.length > 500_000 || !item.text.trim()) invalid('附件正文必须是长度不超过 500000 的非空文本');
    return { name, text: item.text };
  });
  if (!text && !attachments.length) invalid('请输入任务或上传文本资料');
  if (!Array.isArray(body.memoryIds ?? []) || (body.memoryIds?.length || 0) > 20) invalid('memoryIds 必须是最多 20 个显式记忆 ID');
  for (const memoryId of body.memoryIds || []) store.require('memory', memoryId);
  if (mode === 'connection') {
    store.require('connection', body.connectionId);
  }
  let action = null;
  if (body.action) {
    const validateCall = (call) => {
      if (!call || typeof call !== 'object') invalid('工具调用必须是对象');
      const toolName = textValue(call.toolName, 'toolName', 200);
      if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments) || JSON.stringify(call.arguments).length > 100_000) invalid('工具 arguments 必须是不超过 100000 字符的 JSON 对象');
      return { toolName, arguments: call.arguments };
    };
    action = validateCall(body.action);
    if (body.action.verification) {
      action.verification = validateCall(body.action.verification);
      if (body.action.verification.expected) {
        const { path, equals } = body.action.verification.expected;
        if (typeof path !== 'string' || (path !== '' && !path.startsWith('/')) || !Object.hasOwn(body.action.verification.expected, 'equals')) invalid('verification.expected 必须包含 JSON Pointer path 和 equals');
        action.verification.expected = { path, equals };
      }
    }
  }
  return { text, mode, attachments, connectionId: mode === 'connection' ? body.connectionId : null,
    memoryIds: body.memoryIds || [], action, localAgentId, clientId: body.clientId };
}

function endpointURL(value) {
  let parsed;
  try { parsed = new URL(value); } catch { invalid('请输入有效的 JSON-RPC 端点 URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) invalid('连接仅接受无账号、密码或查询参数的 HTTP(S) URL');
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) invalid('远端连接必须使用 HTTPS；HTTP 仅用于本机回环地址');
  return parsed.href;
}

async function readJSON(request) {
  if (!request.headers['content-type']?.split(';')[0].trim().startsWith('application/json')) throw new APIError(415, 'unsupported_media_type', '请求必须使用 application/json');
  let size = 0, chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new APIError(413, 'request_too_large', '请求内容最多 2 MB');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('请求正文必须是 JSON 对象');
    return body;
  } catch (error) { if (error instanceof APIError) throw error; invalid('请求正文不是有效 JSON'); }
}

function publicConnection(connection) {
  return { id: connection.id, name: connection.name, type: connection.type, url: connection.url, createdAt: connection.createdAt,
    ...(connection.node ? { node: connection.node } : {}),
    auth: { type: connection.credentialRef ? 'bearer' : 'none', configured: Boolean(connection.credentialRef), identityVerified: false },
    status: connection.checkedAt ? 'checked' : 'configured', checkedAt: connection.checkedAt || null, presetId: connection.presetId,
    capabilities: connection.type === 'a2a' ? ['message/send', 'tasks/get'] : ['tools/list', 'approved tools/call'] };
}

export async function createPersonalServer(options = {}) {
  const build = { ref: String(options.buildRef || process.env.PERSONAL_BUILD_REF || 'development').slice(0, 200), serverFiles: {} };
  for (const filename of ['index.mjs', 'runtime.mjs', 'im-participation.mjs', 'store.mjs', 'vault.mjs', 'local-agents.mjs', 'integrations.mjs', 'messenger.mjs', 'unread.mjs', 'group-avatar.mjs', 'agent-profiles.mjs', 'agent-onboarding.mjs', 'agent-scheduler.mjs', 'host-discovery.mjs', 'tool-sessions.mjs', 'agentroom-tool-proxy.mjs', 'agentroom-pi-tools.mjs', 'artifact-store.mjs', 'artifact-tools.mjs', 'creation-service.mjs', 'collaboration-runtime.mjs', 'artifact-api.mjs', 'provider-approvals.mjs', 'native-services.mjs', 'remote-nodes.mjs', 'desktop-sharing.mjs', 'device-network.mjs']) {
    build.serverFiles[filename] = digest(await readFile(new URL(filename, import.meta.url), 'utf8'));
  }
  try { build.uiEntrySha256 = digest(await readFile(join(options.staticDir || join(appDir, 'dist'), 'index.html'), 'utf8')); }
  catch { build.uiEntrySha256 = null; }
  build.serverFiles['workspace-guide.mjs'] = digest(await readFile(new URL('./workspace-guide.mjs', import.meta.url), 'utf8'));
  const dataDir = resolve(options.dataDir || process.env.PERSONAL_DATA_DIR || join(repoDir, '.local/personal'));
  const host = options.host || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Personal workspace must bind to a loopback address');
  const port = options.port ?? Number(process.env.PERSONAL_PORT || 18740);
  const store = new PersonalStore(dataDir);
  const unread = new UnreadMessages(store);
  store.recover();
  // Adopt existing populated workspaces without interrupting their normal entry.
  if (!store.get('setting', 'workspace-onboarding') && (store.list('thread').length || store.list('connection').length || store.list('memory').length || store.list('contact').some(contact => contact.id !== 'self' && !contact.discovered))) {
    store.put('setting', { id: 'workspace-onboarding', completed: true, adoptedAt: now() });
  }
  let creation, guide;
  const messenger = new Messenger(store, { onGroupChanged: threadId => creation?.reconcileMembership(threadId),
    onSync: detected => guide?.sync(detected), guideContext: () => guideContext(store) });
  guide = new WorkspaceGuide(store, messenger);
  const remoteNodes = new RemoteNodes(store, publicConnection);
  const clients = new Set();
  const notify = (event = {}) => {
    options.onChange?.(event);
    for (const response of clients) response.write(`event: invalidation\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const commands = Object.fromEntries(['codex', 'claude', 'pi', 'gemini', 'opencode'].map(agent => [agent, process.env[`AGENTSTUDIO_${agent.toUpperCase()}_BIN`] || agent]));
  commands.codex = options.codexCommand || commands.codex;
  const localAgentDeps = { ...(options.localAgentDeps || {}), commands: { ...commands, ...options.localAgentDeps?.commands } };
  const onboarding = new AgentOnboarding(store, messenger, { execute: options.executeLocalAgent, deps: localAgentDeps, notify });
  onboarding.recover();
  const worker = new PersonalWorker(store, { ...options, localAgentDeps, executeOnboarding: (thread, run, signal) => onboarding.execute(thread, run, signal) }, notify);
  creation = new CreationService(store, { ...options, localAgentDeps, notify, cancelRun: (threadId, runId) => worker.cancel(threadId, runId) });
  worker.options.creationService = creation;
  creation.artifacts.recover(); creation.runtime.recover();
  const artifactAPI = new ArtifactAPI(creation, () => worker.kick());
  const providerApprovals = new ProviderApprovals(store, messenger, notify, () => worker.kick(), options.providerApprovals);
  const codex = codexAvailable(options.codexCommand);
  const localAgentOptions = { deps: localAgentDeps };
  const localAgents = (force = false) => (options.discoverLocalAgents || discoverLocalAgents)({ ...localAgentOptions, force });
  const sharing = new DesktopSharing(store, messenger, { refresh: async () => messenger.sync(await localAgents()), validateInput: input => validateInput(store, input), kick: () => worker.kick(), notify, addresses: options.sharingAddresses, port: options.sharingPort });
  const scheduler = new AgentScheduler(store, messenger, { clock: options.schedulerNow, validateInput: input => validateInput(store, input),
    refresh: async () => messenger.sync(await localAgents()), kick: () => worker.kick(), notify });
  worker.options.agentScheduler = scheduler;
  scheduler.recover();
  const acceptedLocalInput = (body, detected) => {
    const input = validateInput(store, body);
    const agent = detected?.agents.find(item => item.id === input.localAgentId);
    // Historical missing-CLI runs retain their blocked/recovery behavior. A
    // server-owned custom executor is used only by isolated test harnesses.
    if (input.mode !== 'codex' || !agent?.installed || (input.localAgentId === 'codex' && options.codexArgs)) return input;
    try { return { ...input, executionSnapshot: resolveExecution(agent.profile) }; }
    catch (error) { throw new APIError(400, 'configuration_required', error.message); }
  };
  const stopProfileWatch = options.discoverLocalAgents ? () => {} : watchAgentProfiles(() => notify({ kind: 'agent_configuration' }), localAgentDeps);
  const presets = options.toolPresets || TOOL_PRESETS;
  const integrationRequests = new Map();
  let shuttingDown = false;
  const json = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(store.vault.redact(body)));
  };

  async function saveConnection(body, { verifyTools = false, checkedAt, presetId } = {}) {
    const name = textValue(body.name, '连接名称', 100), urlValue = endpointURL(body.url);
    if (!['a2a', 'mcp'].includes(body.type)) invalid('连接类型必须是 a2a 或 mcp');
    if (body.headers !== undefined || body.authorization !== undefined || body.authHeader !== undefined) invalid('连接仅支持可选 Bearer token，不支持自定义认证头');
    const token = validateBearerToken(body.token);
    const fingerprint = token ? store.vault.fingerprint(token, body.type, urlValue) : null;
    const matching = () => store.list('connection').find(item => item.url === urlValue && item.type === body.type &&
      (token ? item.credentialFingerprint === fingerprint : !item.credentialRef));
    const existing = matching();
    let candidate = existing || { id: id('con'), name, url: urlValue, type: body.type, createdAt: now(), credentialVersion: token ? 1 : 0 };
    try {
      if (!existing && token) candidate = { ...candidate, credentialRef: store.vault.create(token, candidate), credentialFingerprint: fingerprint };
      if (candidate.type === 'mcp') {
        candidate = await initializeMCP(store, candidate, undefined, false);
        if (verifyTools) {
          let tools;
          try { tools = await rpc(candidate, 'tools/list', {}, undefined, id('list'), undefined, store.vault); }
          catch (error) {
            if (error.upstreamStatus !== 404 || !candidate.sessionId) throw error;
            candidate = await initializeMCP(store, { ...candidate, initializedAt: null, sessionId: null }, undefined, false);
            tools = await rpc(candidate, 'tools/list', {}, undefined, id('list'), undefined, store.vault);
          }
          if (!Array.isArray(tools?.tools)) throw new APIError(502, 'invalid_tool_catalog', '服务没有返回有效的能力列表，尚未连接');
          checkedAt = now();
        }
      }
      const make = () => {
        const current = matching();
        return store.put('connection', { ...candidate, ...(current || {}),
          ...(candidate.type === 'mcp' ? { protocolVersion: candidate.protocolVersion, sessionId: candidate.sessionId, initializedAt: candidate.initializedAt } : {}),
          ...(checkedAt ? { checkedAt } : {}), ...(presetId ? { presetId } : {}) });
      };
      const safeInput = token ? { ...body, token: undefined, authFingerprint: fingerprint } : body;
      const connection = body.clientId ? store.idempotent('connections:create', body.clientId, safeInput, make) : store.transaction(make);
      if (!existing && connection.id !== candidate.id) store.vault.removeForConnection(candidate.id);
      notify(); return publicConnection(connection);
    } catch (error) {
      if (!existing && !store.get('connection', candidate.id)) store.vault.removeForConnection(candidate.id);
      throw error;
    }
  }

  let switchPrepared = false, activeMutations = 0;
  const blockingRuns = () => store.list('thread').flatMap(thread => thread.runs || []).filter(run =>
    ['queued', 'running', 'verifying', 'needs_input', 'unknown'].includes(run.status) || run.cancelPending || run.stopUnconfirmed || run.requiresReconciliation).length + artifactAPI.blockers() + store.list('thread').flatMap(thread => thread.decisions || []).filter(decision => decision.kind === 'provider_approval' && ['pending','sending','unknown'].includes(decision.state)).length;
  const cancelWorkspaceSwitch = () => {
    if (!switchPrepared || shuttingDown) return;
    sharing.suspended = false;
    switchPrepared = false; scheduler.closed = false; scheduler.start(options.schedulerTickMs ?? 30_000);
  };
  const server = http.createServer(async (request, response) => {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutating) activeMutations++;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (switchPrepared && mutating) throw new APIError(409, 'workspace_switching', '工作区正在切换，没有接受新的操作');
      const boundPort = server.address()?.port || port;
      const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);
      if (!allowedHosts.has(request.headers.host)) throw new APIError(403, 'forbidden_host', '仅允许本机访问');
      const origin = request.headers.origin;
      if (origin && ![`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, `http://[::1]:${boundPort}`, 'http://127.0.0.1:18741', 'http://localhost:18741'].includes(origin)) {
        throw new APIError(403, 'forbidden_origin', '不允许此网页访问本机资料');
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new APIError(403, 'forbidden_origin', '不允许跨站访问');
      const url = new URL(request.url, `http://${request.headers.host}`);
      const path = url.pathname;
      const method = request.method;
      let match;
      const artifactResult = await artifactAPI.route(method, path, () => readJSON(request));
      if (artifactResult !== undefined) return json(response, 200, artifactResult);
      if (method === 'GET' && path === '/api/workspace/status') {
        return json(response, 200, { blockingRuns: blockingRuns() });
      }
      if (method === 'POST' && path === '/api/workspace/onboarding') {
        const body = await readJSON(request);
        if (Object.keys(body).some(key => !['action', 'name', 'clientId'].includes(key)) || !['complete', 'restart'].includes(body.action)) invalid('请选择完成或重新查看引导');
        const name = body.action === 'complete' ? textValue(body.name, '名称', 80) : null;
        const result = store.idempotent('workspace:onboarding', body.clientId, body, () => {
          if (name) {
            const owner = store.require('contact', 'self');
            store.put('contact', { ...owner, name, version: owner.version + 1, updatedAt: now() });
          }
          return store.put('setting', { id: 'workspace-onboarding', completed: body.action === 'complete', updatedAt: now() });
        });
        notify(); return json(response, 200, result);
      }
      if (method === 'GET' && path === '/api/health') return json(response, 200, { ok: true, service: 'agentstudio-personal', durableQueue: true, build });
      if (method === 'GET' && path === '/api/im/settings') return json(response, 200, messenger.settings());
      if (method === 'POST' && path === '/api/im/settings') {
        const body = await readJSON(request);
        const result = store.idempotent('im:settings', body.clientId, body, () => messenger.saveSettings(body));
        notify(); return json(response, 200, result);
      }
      if (method === 'POST' && (match = path.match(/^\/api\/threads\/([A-Za-z0-9_-]+)\/reactions$/))) {
        const body = await readJSON(request);
        const result = store.idempotent(`reaction:${match[1]}`, body.clientId, body, () => messenger.react(match[1], body));
        notify({ threadId: match[1] }); return json(response, 200, result);
      }
      if (method === 'GET' && path === '/api/sharing') { messenger.sync(await localAgents()); return json(response, 200, sharing.status()); }
      if (method === 'POST' && path === '/api/sharing') return json(response, 200, await sharing.save(await readJSON(request)));
      if (method === 'POST' && path === '/api/sharing/invite') {
        await readJSON(request);
        // Explicit, trusted local reveal: ordinary responses always redact secrets.
        const invitation = sharing.invitation();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(invitation)); return;
      }
      if (method === 'GET' && path === '/api/contacts') return json(response, 200, { contacts: messenger.sync(await localAgents()) });
      if (method === 'GET' && path === '/api/host/discovery') {
        const detected = await localAgents();
        return json(response, 200, collectHostDiscovery({ contacts: messenger.sync(detected), integrations: store.list('connection'), localAgents: detected }));
      }
      if (method === 'POST' && path === '/api/contacts/local') {
        const body = await readJSON(request);
        if (Object.keys(body).some(key => !['agentIds', 'clientId'].includes(key))) invalid('快速添加只接受本机助手选择');
        const detected = await localAgents(true);
        messenger.sync(detected);
        const result = store.idempotent('contacts:local:add', body.clientId, body, () => ({ contacts: messenger.addLocalAgents(body, detected) }));
        notify(); return json(response, 200, result);
      }
      if ((match = path.match(/^\/api\/contacts\/([A-Za-z0-9_-]+)\/(control|run)$/))) {
        const contactId = match[1], action = match[2];
        messenger.sync(await localAgents());
        if (method === 'GET' && action === 'control') return json(response, 200, scheduler.get(contactId));
        if (method === 'POST') {
          const body = await readJSON(request);
          if (Object.keys(body).some(key => !(action === 'control' ? ['version', 'clientId', 'goal', 'scheduler'] : ['version', 'clientId']).includes(key))) invalid('目标调度包含不支持的选项');
          const result = store.idempotent(`contacts:${contactId}:${action}`, body.clientId, body, () => action === 'control' ? scheduler.save(contactId, body) : scheduler.runNow(contactId, body));
          notify({ contactId }); worker.kick(); return json(response, action === 'run' ? 202 : 200, result);
        }
      }
      if (method === 'GET' && (match = path.match(/^\/api\/contacts\/([A-Za-z0-9_-]+)$/))) return json(response, 200, messenger.publicContact(store.require('contact', match[1])));
      if (method === 'POST' && (path === '/api/contacts' || (match = path.match(/^\/api\/contacts\/([A-Za-z0-9_-]+)$/)))) {
        const contactId = match?.[1], body = await readJSON(request);
        const result = store.idempotent(`contacts:${contactId || 'create'}`, body.clientId, body, () => messenger.saveContact(body, contactId));
        notify(); return json(response, contactId ? 200 : 201, result);
      }
      if (method === 'GET' && path === '/api/agent-onboarding/context') return json(response, 200, onboarding.context());
      if (method === 'GET' && path === '/api/agent-onboarding') return json(response, 200, { jobs: store.list('agent_onboarding').slice(0, 20).map(j => onboarding.get(j.id)) });
      if (method === 'POST' && path === '/api/agent-onboarding') {
        const body = await readJSON(request), detected = await localAgents();
        messenger.sync(detected);
        const result = store.idempotent('agent-onboarding:create', body.clientId, body, () => onboarding.start(body, detected));
        notify({ onboardingId: result.id }); worker.kick(); return json(response, 202, onboarding.get(result.id));
      }
      if (method === 'GET' && (match = path.match(/^\/api\/agent-onboarding\/([A-Za-z0-9_-]+)$/))) return json(response, 200, onboarding.get(match[1]));
      if (method === 'POST' && (match = path.match(/^\/api\/agent-onboarding\/([A-Za-z0-9_-]+)\/(adopt|cancel)$/))) {
        const jobId = match[1], action = match[2], body = await readJSON(request);
        if (Object.keys(body).some(k => !['clientId', 'suggestionId'].includes(k))) invalid('角色操作包含不支持的选项');
        const result = store.idempotent(`agent-onboarding:${jobId}:${action}`, body.clientId, body, () => action === 'adopt' ? onboarding.adopt(jobId, body.suggestionId) : onboarding.cancel(jobId));
        if (action === 'cancel') { const job = onboarding.get(jobId), thread = store.require('thread', job.threadId); worker.cancel(thread.id, thread.runs[0].id); }
        notify({ onboardingId: jobId }); worker.kick(); return json(response, 200, result);
      }
      if (method === 'GET' && path === '/api/approvals') return json(response, 200, { approvals: messenger.approvals() });
      if (method === 'POST' && (path === '/api/chats' || (match = path.match(/^\/api\/chats\/([A-Za-z0-9_-]+)$/)))) {
        const threadId = match?.[1], body = await readJSON(request);
        const result = store.idempotent(`chats:${threadId || 'create'}`, body.clientId, body, () => threadId ? messenger.updateChat(threadId, body) : messenger.createChat(body));
        notify({ threadId: result.id }); return json(response, threadId ? 200 : 201, result);
      }
      if ((method === 'GET' && path === '/api/integrations') || (method === 'POST' && path === '/api/integrations/refresh')) {
        if (method === 'POST') await readJSON(request);
        const detected = await localAgents(method === 'POST');
        return json(response, 200, { ...detected, nodes: remoteNodes.list(), selectedLocalAgentId: store.get('setting', 'local-agent')?.agentId || 'codex',
          presets: presets.map(({ id: presetId, name, description, account, url: endpoint }) => ({ id: presetId, name, description, account,
            connectionId: store.list('connection').find(item => item.type === 'mcp' && item.url === endpoint)?.id || null })) });
      }
      if (method === 'POST' && path === '/api/nodes/connect') {
        const result = await remoteNodes.connect(await readJSON(request));
        messenger.sync(await localAgents()); notify(); return json(response, 201, result);
      }
      if (method === 'POST' && (match = path.match(/^\/api\/nodes\/([A-Za-z0-9_-]+)\/check$/))) {
        await readJSON(request);
        try { return json(response, 200, await remoteNodes.check(match[1])); }
        finally { notify(); }
      }
      if (method === 'POST' && (match = path.match(/^\/api\/integrations\/local\/(codex|claude|pi)$/))) {
        await readJSON(request);
        const detected = await localAgents(true), agent = detected.agents.find(item => item.id === match[1]);
        if (!agent?.installed || !agent.execution.supported) throw new APIError(409, 'local_agent_unavailable', '尚未找到可执行的本机助手，请先安装后重新检查');
        if (agent.auth.status !== 'configured') throw new APIError(409, 'local_agent_login_required', '请先完成或重新检查本机助手登录，再点击使用');
        store.put('setting', { id: 'local-agent', agentId: agent.id, selectedAt: now() });
        notify(); return json(response, 200, { selectedLocalAgentId: agent.id });
      }
      if (method === 'POST' && path === '/api/integrations/connect') {
        const body = await readJSON(request);
        if (Object.keys(body).some(key => !['presetId', 'url', 'token', 'clientId'].includes(key))) invalid('连接入口不接受自定义命令或协议参数');
        const token = validateBearerToken(body.token);
        const original = { ...body, token: undefined, ...(token ? { authFingerprint: store.vault.fingerprint(token, 'auto', String(body.url)) } : {}) };
        if (body.clientId) {
          const receipt = store.replay('integrations:create', body.clientId, original);
          if (receipt.found) return json(response, 201, receipt.value);
          const pending = integrationRequests.get(body.clientId);
          if (pending) {
            if (pending.fingerprint !== digest(JSON.stringify(original))) throw new APIError(409, 'idempotency_conflict', '相同 clientId 的请求内容不同');
            return json(response, 201, await pending.promise);
          }
        }
        const promise = (async () => {
          let connection;
          if (body.presetId) {
            if (body.url || body.token) invalid('预设连接不接受另外的地址或凭据');
            const preset = presetConnection(body.presetId, presets);
            connection = await saveConnection(preset, { verifyTools: true, presetId: preset.presetId });
          } else {
            const urlValue = integrationURL(body.url);
            const card = await inspectAgentCard(urlValue, { token, ...(options.integrationFetch ? { fetch: options.integrationFetch } : {}) });
            const credentials = token ? { token } : {};
            connection = card
              ? await saveConnection({ name: card.name, type: 'a2a', url: card.url, ...credentials }, { checkedAt: card.discovery.checkedAt })
              : await saveConnection({ name: new URL(urlValue).hostname === 'localhost' ? '本机工具' : `${new URL(urlValue).hostname} 的工具`, type: 'mcp', url: urlValue, ...credentials }, { verifyTools: true });
          }
          return body.clientId ? store.idempotent('integrations:create', body.clientId, original, () => connection) : connection;
        })();
        if (body.clientId) integrationRequests.set(body.clientId, { fingerprint: digest(JSON.stringify(original)), promise });
        try { return json(response, 201, await promise); }
        finally { if (body.clientId) integrationRequests.delete(body.clientId); }
      }
      if (method === 'GET' && path === '/api/bootstrap') {
        messenger.sync(await localAgents());
        return json(response, 200, {
          workspace: { onboardingCompleted: Boolean(store.get('setting', 'workspace-onboarding')?.completed), displayName: store.get('contact', 'self')?.name || '你', guide: guide.state() },
          threads: store.list('thread').filter(t => !['agent_onboarding', 'device_request'].includes(t.purpose)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id: threadId, title, status, summary, updatedAt, kind, memberIds, version, groupAvatar, messages, decisions }) => ({ id: threadId, title, status, summary, updatedAt,
            ...(kind ? { kind, memberIds, version } : {}), ...(kind === 'group' ? { groupAvatar: groupAvatar ?? null } : {}), lastMessage: messages.at(-1) ? { text: messages.at(-1).text.slice(0, 160), contactId: messages.at(-1).contactId } : null,
            pendingApprovals: decisions.filter(d => d.state === 'pending').length, ...unread.state({ id: threadId, messages }) })),
          connections: store.list('connection').map(publicConnection), memories: store.list('memory'),
          settings: { im: messenger.settings(), defaultMode: 'codex', codexAvailable: codex.available, codexVersion: codex.version,
            localAgentId: store.get('setting', 'local-agent')?.agentId || 'codex' },
          runtime: { localOnly: true, database: 'SQLite WAL', queue: 'single-process', localMode: '本地统计与摘录，无需模型',
            codexBoundary: '继承本机 Codex 提供商配置，shell 使用 read-only；独立 cwd 不是文件系统隔离，CLI 已配置工具仍遵守其自身权限。结果仅证明文档已保存。',
            connectionBoundary: 'A2A message/send 与 tasks/get；MCP 2025 握手、会话 ID、JSON/SSE 响应、tools/list 与精确批准后的 tools/call。可选本机加密保存的 Bearer；无任意认证头、OAuth、反向请求、2026 新协议或远端回调。' },
        });
      }
      if (method === 'GET' && path === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write('retry: 2000\nevent: invalidation\ndata: {}\n\n');
        clients.add(response);
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20_000);
        heartbeat.unref();
        request.on('close', () => { clearInterval(heartbeat); clients.delete(response); });
        return;
      }
      if (method === 'POST' && path === '/api/integrations/local/pi/identity') {
        await readJSON(request);
        return json(response, 200, await readPiIdentity(localAgentDeps));
      }
      if (method === 'POST' && path === '/api/threads') {
        const body = await readJSON(request);
        const detected = body.mode && body.mode !== 'codex' ? null : await localAgents();
        const thread = store.idempotent('threads:create', body.clientId, body, () => store.createThread(acceptedLocalInput(body, detected)));
        notify({ threadId: thread.id }); worker.kick();
        return json(response, 201, thread);
      }
      if (method === 'GET' && (match = path.match(/^\/api\/threads\/([^/]+)$/))) return json(response, 200, { ...store.require('thread', match[1]), ...unread.state(store.require('thread', match[1])), creation: creation.forThread(match[1]) });
      if (method === 'POST' && (match = path.match(/^\/api\/threads\/([^/]+)\/read$/))) {
        const body = await readJSON(request);
        const { changed, ...state } = unread.markRead(match[1], body.messageId);
        if (changed) notify({ threadId: match[1] });
        return json(response, 200, state);
      }
      if (method === 'POST' && (match = path.match(/^\/api\/threads\/([^/]+)\/messages$/))) {
        const threadId = match[1], body = await readJSON(request);
        if (store.require('thread', threadId).purpose === 'agent_onboarding') throw new APIError(409, 'onboarding_thread', '角色准备请使用专用进度和取消入口');
        const detected = await localAgents();
        if (store.require('thread', threadId).kind) messenger.sync(detected);
        const result = store.idempotent(`threads:${threadId}:messages`, body.clientId, body, () => {
          const thread = store.require('thread', threadId);
          if (thread.kind) return messenger.appendMessage(thread, body, input => validateInput(store, input));
          const input = acceptedLocalInput(body, detected);
          store.appendRun(thread, input); return store.put('thread', thread);
        });
        notify({ threadId }); worker.kick(); return json(response, 200, result);
      }
      if (method === 'POST' && (match = path.match(/^\/api\/threads\/([^/]+)\/(retry|reconcile|cancel)$/))) {
        const threadId = match[1], action = match[2], body = await readJSON(request);
        if (store.require('thread', threadId).purpose === 'agent_onboarding') throw new APIError(409, 'onboarding_thread', '角色准备请使用专用进度和取消入口');
        const record = store.idempotent(`threads:${threadId}:${action}`, body.clientId, body, () => {
          const thread = store.require('thread', threadId);
          const run = body.runId ? thread.runs.find((item) => item.id === body.runId) : action === 'cancel'
            ? thread.runs.find((item) => ['running', 'verifying'].includes(item.status)) || thread.runs.find((item) => item.status === 'needs_input') || thread.runs.find((item) => item.status === 'queued') || thread.runs.find((item) => store.unresolved(item)) || thread.runs.at(-1)
            : thread.runs.find((item) => store.unresolved(item)) || thread.runs.at(-1);
          if (!run) invalid('没有可以处理的运行记录');
          if (run.collaboration) throw new APIError(409, 'collaboration_control_required', '共创步骤请从作品卡片处理，不能作为普通聊天重复派工');
          if (action === 'cancel') {
            if (run.mode === 'codex' && (run.status === 'unknown' || run.stopUnconfirmed)) {
              run.status = 'unknown'; run.requiresReconciliation = true;
              thread.summary = '原执行结果或停止状态尚未确认；不会通过取消重新开放派工';
              store.refreshThread(thread); store.put('thread', thread); return { thread, runId: run.id };
            }
            if (terminal.includes(run.status) && run.status !== 'unknown' && run.status !== 'blocked') return { thread, runId: run.id };
            const localStopping = run.mode === 'codex' && ['running', 'verifying'].includes(run.status);
            const uncertain = run.mode === 'connection' && ['sending', 'delivered', 'unknown'].includes(run.deliveryState);
            run.status = 'cancelled'; run.finishedAt = now(); thread.status = 'cancelled';
            thread.summary = uncertain ? '已停止本机等待；远端执行未获取消确认，请在远端核查' : '任务已取消';
            run.requiresReconciliation = uncertain;
            if (localStopping) { run.cancelPending = true; thread.summary = '已请求停止，正在确认本机助手退出'; }
            if (uncertain) run.error = thread.summary;
            for (const decision of thread.decisions.filter((item) => item.runId === run.id && item.state === 'pending')) {
              decision.state = 'cancelled'; decision.version += 1;
            }
            store.event(thread, 'cancelled', thread.summary, { runId: run.id });
          } else {
            if (!terminal.includes(run.status)) throw new APIError(409, 'active_run', '任务仍在进行中');
            if (run.agentSchedule && action === 'retry' && !run.externalTaskId) throw new APIError(409, 'goal_retry_policy', '目标运行请从 Agent 设置中点击立即运行，按当前目标和每日次数重新安排');
            if (run.mode === 'connection' && run.externalTaskId) {
              run.status = 'queued'; run.phase = 'reconcile'; delete run.error; delete run.finishedAt;
              thread.status = 'queued'; thread.summary = '已排队核查原远端任务，不会重新提交';
              store.event(thread, 'queued', thread.summary, { runId: run.id });
            } else {
              if (action === 'reconcile') throw new APIError(409, 'no_remote_task', '没有远端 taskId，无法自动核查；请检查远端记录');
              if (run.status === 'unknown' || ['sending', 'delivered', 'unknown'].includes(run.deliveryState)) throw new APIError(409, 'unknown_execution', '上次执行结果未知，不能重复提交；请先人工核查');
              const message = thread.messages.find((item) => item.id === run.messageId);
              store.appendRun(thread, { ...message, mode: run.mode, localAgentId: run.localAgentId || 'codex', connectionId: run.connectionId, action: run.action, memoryIds: run.memoryIds, reuseMessageId: message.id,
                executionSnapshot: run.executionSnapshot, contactId: run.contactId, contactSnapshot: run.contactSnapshot, participantSnapshot: run.participantSnapshot, conversationSnapshot: run.conversationSnapshot,
                visibleAfterMessageId: run.visibleAfterMessageId, responsePolicy: run.responsePolicy, imPolicy: run.imPolicy, participantMemberships: run.participantMemberships, connectionIdentityId: run.id });
            }
          }
          store.refreshThread(thread);
          thread.updatedAt = now(); store.put('thread', thread);
          return { thread, runId: run.id };
        });
        // Older persisted idempotency records contained only the thread snapshot.
        const result = record.thread || record;
        if (action === 'cancel') worker.cancel(threadId, record.runId || result.runs.at(-1)?.id);
        if (action === 'cancel') scheduler.afterRun(threadId, record.runId || result.runs.at(-1)?.id);
        notify({ threadId }); worker.kick(); return json(response, 200, result);
      }
      if (method === 'POST' && (match = path.match(/^\/api\/decisions\/([^/]+)$/))) {
        const decisionId = match[1], body = await readJSON(request);
        const result = store.idempotent(`decisions:${decisionId}`, body.clientId, body, () => {
          const thread = store.list('thread').find((item) => item.decisions.some((decision) => decision.id === decisionId));
          if (!thread) throw new APIError(404, 'not_found', '找不到这条确认');
          const decision = thread.decisions.find((item) => item.id === decisionId);
          if (decision.version !== body.version) throw new APIError(409, 'version_conflict', '确认卡已更新，请刷新后操作');
          if (decision.state !== 'pending') throw new APIError(409, 'already_decided', '这条确认已经处理');
          if (decision.kind === 'provider_approval') return store.put('thread', providerApprovals.choose(thread, decision, body));
          if (!['approve', 'reject'].includes(body.choice)) invalid('choice 必须是 approve 或 reject');
          const run = thread.runs.find((item) => item.id === decision.runId);
          if (run.status !== 'needs_input') throw new APIError(409, 'inactive_decision', '任务当前无法接收确认');
          decision.state = 'decided'; decision.version += 1; decision.decision = { choice: body.choice, decidedAt: now() };
          run.status = body.choice === 'approve' ? 'queued' : 'cancelled';
          thread.status = run.status; thread.summary = body.choice === 'approve' ? '决定已记录，等待发送；尚未执行' : '未发送给远端代理';
          if (body.choice === 'reject') run.finishedAt = now();
          store.event(thread, 'decision', thread.summary, { runId: run.id, decisionId });
          store.refreshThread(thread);
          thread.updatedAt = now(); return store.put('thread', thread);
        });
        notify({ threadId: result.id }); worker.kick(); void providerApprovals.tick(); return json(response, 200, result);
      }
      if (method === 'GET' && (match = path.match(/^\/api\/artifacts\/([^/]+)(\/download)?$/))) {
        const artifact = store.require('artifact', match[1]);
        if (digest(artifact.body) !== artifact.sha256) throw new APIError(500, 'artifact_corrupted', '成果哈希校验失败，无法作为已验证结果返回');
        if (!match[2]) return json(response, 200, artifact);
        response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        response.setHeader('Content-Disposition', `attachment; filename="${artifact.id}.md"`);
        response.end(artifact.body); return;
      }
      if (method === 'GET' && path === '/api/memories') return json(response, 200, { memories: store.list('memory') });
      if (method === 'POST' && path === '/api/memories') {
        const body = await readJSON(request), text = textValue(body.text, '记忆', 5000);
        const memory = store.idempotent('memories:create', body.clientId, body, () => store.put('memory', { id: id('mem'), text, createdAt: now(), source: 'explicit_user' }));
        notify(); return json(response, 201, memory);
      }
      if (method === 'DELETE' && (match = path.match(/^\/api\/memories\/([^/]+)$/))) {
        store.delete('memory', match[1]); notify(); return json(response, 200, { ok: true });
      }
      if (method === 'GET' && path === '/api/connections') return json(response, 200, { connections: store.list('connection').map(publicConnection) });
      if (method === 'POST' && path === '/api/connections') return json(response, 201, await saveConnection(await readJSON(request)));
      if (method === 'DELETE' && (match = path.match(/^\/api\/connections\/([^/]+)$/))) {
        const connectionId = match[1];
        if (store.list('thread').some(thread => thread.decisions.some(decision => decision.kind === 'provider_approval' && decision.providerConnectionId === connectionId && ['pending','sending','unknown'].includes(decision.state))) || store.list('provider_answer').some(answer => answer.connectionId === connectionId && ['queued','sending','unknown'].includes(answer.state))) throw new APIError(409, 'connection_in_use', '此连接仍有审批或待核查的选择，请先在原服务处理');
        if (store.list('thread').some((thread) => thread.runs.some((run) => run.connectionId === connectionId &&
          (!['completed', 'failed', 'cancelled'].includes(run.status) || (run.status === 'cancelled' && ['sending', 'delivered', 'unknown'].includes(run.deliveryState) && !['canceled', 'cancelled'].includes(run.remoteStatus)))))) {
          throw new APIError(409, 'connection_in_use', '此连接仍有进行中或待核查任务，请先处理任务');
        }
        remoteNodes.suppress(store.get('connection', connectionId));
        store.delete('connection', connectionId);
        store.vault.removeForConnection(connectionId);
        notify(); return json(response, 200, { ok: true });
      }
      if (method === 'GET' && (match = path.match(/^\/api\/connections\/([^/]+)\/tools$/))) {
        const connection = store.require('connection', match[1]);
        if (connection.type !== 'mcp') invalid('仅 MCP 连接支持工具发现');
        return json(response, 200, await discoverMCP(store, connection));
      }
      if (path.startsWith('/api/')) throw new APIError(404, 'not_found', '找不到这个 API');
      if (method !== 'GET' && method !== 'HEAD') throw new APIError(405, 'method_not_allowed', '不支持此请求方法');
      const distDir = options.staticDir || join(appDir, 'dist');
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { invalid('路径编码无效'); }
      let filename = resolve(distDir, `.${decoded}`);
      if (filename !== distDir && !filename.startsWith(`${distDir}${sep}`)) throw new APIError(403, 'forbidden', '路径不允许');
      try { if (!(await stat(filename)).isFile()) filename = join(distDir, 'index.html'); }
      catch { filename = join(distDir, 'index.html'); }
      let content;
      try { content = await readFile(filename); } catch { throw new APIError(503, 'ui_not_built', '请先构建 personal 前端，API 已启动'); }
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
      response.setHeader('Content-Type', `${mime[extname(filename)] || 'application/octet-stream'}${['.html', '.js', '.css'].includes(extname(filename)) ? '; charset=utf-8' : ''}`);
      response.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const expected = error instanceof APIError;
      json(response, expected ? error.status : 500, { error: { code: expected ? error.code : 'internal_error', message: expected ? error.message : '本机服务遇到错误，任务状态已保留，请刷新核查' } });
    } finally { if (mutating) activeMutations--; }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  remoteNodes.start(notify, options.nodePollMs);
  sharing.start();
  worker.start();
  providerApprovals.start();
  scheduler.start(options.schedulerTickMs ?? 30_000);
  return {
    server, store, worker, scheduler, creation, providerApprovals, sharing,
    registerNativeSource: (source) => providerApprovals.register(source),
    syncNativeServices: (snapshot) => { const catalog = syncNativeServices(store, snapshot, notify); worker.kick(); return catalog; },
    cancelWorkspaceSwitch,
    async prepareWorkspaceSwitch() {
      if (switchPrepared || shuttingDown) throw new Error('Workspace is already switching');
      switchPrepared = true; sharing.suspended = true;
      try {
        await scheduler.close();
        const deadline = Date.now() + 5000;
        while (activeMutations) {
          if (Date.now() > deadline) throw new Error('Workspace still has pending requests');
          await new Promise(resolveWait => setTimeout(resolveWait, 10));
        }
        const count = blockingRuns();
        if (count) cancelWorkspaceSwitch();
        return { blockingRuns: count };
      } catch (error) { cancelWorkspaceSwitch(); throw error; }
    },
    listen: () => new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolveListen(server.address()); });
    }),
    address: () => server.address(),
    async close() {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const client of clients) client.end();
      const stopped = server.listening ? new Promise((resolveClose) => server.close(resolveClose)) : Promise.resolve();
      server.closeIdleConnections();
      await sharing.close(); await remoteNodes.close();
      stopProfileWatch(); await providerApprovals.close(); await scheduler.close(); await worker.close(); await creation.close(); artifactAPI.close(); await stopped; store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createPersonalServer();
  try {
    const address = await app.listen();
    console.log(`AgentRoom personal: http://127.0.0.1:${address.port}`);
  } catch (error) { await app.close(); throw error; }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
