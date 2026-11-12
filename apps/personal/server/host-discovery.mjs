import * as nativeHost from 'node:os';

const localIds = new Set(['codex', 'claude', 'pi', 'gemini', 'opencode']);
const executableIds = new Set(['codex', 'claude', 'pi']);
const platforms = new Set(['darwin', 'linux', 'win32']);
const architectures = new Set(['arm64', 'x64', 'ia32', 'arm']);
const authStates = new Set(['configured', 'required', 'unknown', 'unsupported']);
const connectionReadyStates = new Set(['ready', 'checked', 'configured']);
const colors = new Set(['blue', 'violet', 'teal', 'orange', 'rose']);
const icons = new Set(['auto', 'spark', 'code', 'research', 'write', 'compass', 'brain', 'person']);
const clean = (value, max = 100) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const read = (host, name) => { try { return typeof host?.[name] === 'function' ? host[name]() : null; } catch { return null; } };
const gibibytes = value => Number.isFinite(value) && value >= 0 ? Math.floor(value / 1024 ** 3) : null;

function hostFacts(host) {
  const platform = read(host, 'platform'), architecture = read(host, 'arch');
  const total = read(host, 'totalmem'), free = read(host, 'freemem'), cpus = read(host, 'availableParallelism');
  return { source: host ? 'node:os' : 'unavailable', platform: platforms.has(platform) ? platform : 'unknown',
    architecture: architectures.has(architecture) ? architecture : 'unknown',
    totalMemoryGiB: Number.isFinite(total) && total > 0 ? gibibytes(total) : null,
    freeMemoryGiB: Number.isFinite(total) && total > 0 && free <= total ? gibibytes(free) : null,
    cpuCount: Number.isInteger(cpus) && cpus > 0 && cpus <= 4096 ? cpus : null,
    // Free memory is not macOS memory pressure. Unsampled resources stay unknown.
    memoryPressure: 'unknown', diskAvailableGiB: null, queueDepth: null };
}

function agentFacts(agent, sampled) {
  const configured = sampled && agent.auth?.status === 'configured';
  const supported = executableIds.has(agent.id) && agent.execution?.supported === true;
  return { id: agent.id, name: clean(agent.name) || agent.id,
    version: /^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(agent.version || '') ? agent.version : null,
    authStatus: sampled && authStates.has(agent.auth?.status) ? agent.auth.status : 'unknown',
    executionSupported: supported,
    state: !sampled ? 'unknown' : !supported ? 'unsupported' : configured ? 'configuration_detected'
      : agent.auth?.status === 'required' ? 'login_required' : 'unknown',
    executionVerified: false };
}

function localReady(agent, sampled) {
  return Boolean(sampled && agent?.installed === true && executableIds.has(agent.id)
    && agent.execution?.supported === true && agent.auth?.status === 'configured');
}

function connectionReady(connection) {
  return connection?.type === 'a2a' && timestamp(connection.checkedAt) && !connection.error
    && (connection.status == null || connectionReadyStates.has(connection.status));
}

function contactSummary(contact, providerName, capabilities) {
  const binding = contact.binding;
  return { contactId: clean(contact.id, 160), name: clean(contact.name, 80) || '助手', handle: clean(contact.handle, 32),
    color: colors.has(contact.color) ? contact.color : 'blue', icon: icons.has(contact.icon) ? contact.icon : 'auto',
    ...(binding.type === 'local' ? { localAgentId: binding.localAgentId } : {}), providerName, capabilities,
    source: binding.type === 'local' ? 'installed_local_agent' : 'existing_connection' };
}

function projectContact(contact, { agents, connections, sampled, seenConnections }, configuredOnly = false) {
  if (contact.kind !== 'agent' || contact.availability !== 'ready' || contact.configurationError || !clean(contact.id, 160)) return null;
  const binding = contact.binding;
  let providerName, capabilities;
  if (binding?.type === 'local') {
    if (configuredOnly) return null;
    const agent = agents.find(item => item.id === binding.localAgentId);
    if (!localReady(agent, sampled)) return null;
    providerName = clean(agent.name) || agent.id;
    // Fixed adapter facts. No capability in a model response or agent card is used.
    capabilities = { chat: true, incrementalReply: agent.id === 'claude' ? 'unknown' : 'supported',
      stop: 'supported', conversationIsolation: 'per_thread' };
  } else if (binding?.type === 'connection') {
    const connection = connections.find(item => item.id === binding.connectionId);
    const saved = connection?.type === 'a2a' && timestamp(connection.createdAt) && !connection.error
      && (connection.status == null || connectionReadyStates.has(connection.status));
    if ((configuredOnly ? !saved || connectionReady(connection) : !connectionReady(connection)) || seenConnections.has(connection?.id)) return null;
    seenConnections.add(connection.id);
    providerName = clean(connection.name) || '已连接的助手';
    // Current generic A2A records cannot establish provider-side thread isolation,
    // streaming, or reliable remote stop. Open the existing contact only.
    capabilities = { chat: true, incrementalReply: 'unknown', stop: 'unknown', conversationIsolation: 'unknown' };
  } else return null;
  return { ...contactSummary(contact, providerName, capabilities), ...(configuredOnly ? { statusLabel: '已保存连接，发送时核对' } : {}) };
}

/**
 * Read-only projection of already collected personal workspace facts.
 * contacts must be Messenger.publicContact results; integrations are saved
 * connection records (kept server-side). localAgents is { checkedAt, agents }.
 * host is an optional Node-os-compatible injection; null means unsampled.
 * No model, filesystem scan, login, installation, or settings write occurs here.
 */
export function collectHostDiscovery({ contacts = [], integrations = [], localAgents = null, host = nativeHost, now = Date.now } = {}) {
  const sampledAt = new Date(now()).toISOString();
  const localAgentsCheckedAt = timestamp(localAgents?.checkedAt);
  const agents = (Array.isArray(localAgents?.agents) ? localAgents.agents : []).filter(agent => localIds.has(agent?.id));
  const connections = Array.isArray(integrations) ? integrations : [];
  const context = { agents, connections, sampled: Boolean(localAgentsCheckedAt), seenConnections: new Set() };
  const existingContacts = Array.isArray(contacts) ? contacts.filter(contact => contact.systemRole !== 'guide') : [];
  const readyContacts = existingContacts.map(contact => projectContact(contact, context)).filter(Boolean);
  const configuredContacts = existingContacts.map(contact => projectContact(contact, context, true)).filter(Boolean);
  const canPrepareRoles = agents.some(agent => localReady(agent, context.sampled));
  const candidates = [...readyContacts.filter(contact => contact.source === 'existing_connection'),
    ...configuredContacts, ...readyContacts.filter(contact => contact.source === 'installed_local_agent')];
  const recommendations = candidates.slice(0, canPrepareRoles ? 2 : 3).map(contact => ({
    id: `open:${contact.contactId}`, kind: 'open_contact', contactId: contact.contactId, title: contact.name,
    reason: contact.statusLabel ? `${contact.statusLabel}；沿用已有会话。` : contact.source === 'existing_connection'
      ? '沿用已连接助手的已有会话。' : '这台 Mac 已找到并读取了这个助手的登录配置；实际执行会在发送时核对。',
    source: contact.source,
  }));
  if (canPrepareRoles) recommendations.push({ id: 'prepare_roles', kind: 'prepare_roles', title: '准备合适的伙伴',
    reason: '选择现有助手和资料范围，测试后再准备角色；采用时才会添加联系人。', source: 'existing_role_onboarding' });
  if (!recommendations.length) recommendations.push({ id: 'connect', kind: 'connect', title: '连接自己的助手',
    reason: '尚未确认可聊天的已连接助手。可以检查已有登录，或连接自己的账号。', source: 'local_discovery' });
  return { schemaVersion: 1, sampledAt, localAgentsCheckedAt, host: hostFacts(host),
    agents: agents.filter(agent => agent.installed === true).map(agent => agentFacts(agent, context.sampled)),
    readyContacts, configuredContacts, canPrepareRoles, recommendations,
    excludedToolsCount: connections.filter(connection => connection.type === 'mcp').length };
}
