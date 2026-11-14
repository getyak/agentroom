import { discoverLocalAgents } from './local-agents.mjs';
import { digest } from './store.mjs';

/** Join native inventory with installed server-owned catalog coordinates; never auto-add contacts. */
export function assistantInventory({ manager, deps = {}, discover = discoverLocalAgents }) {
  return async (force = false) => {
    if (!manager) return discover({ deps, force });
    const catalog = await manager.snapshot({ background: false });
    const launches = new Map();
    for (const entry of catalog.entries.filter(entry => entry.installed)) {
      const runtime = await manager.launch(entry.localAgentId);
      if (runtime) launches.set(entry.localAgentId, runtime);
    }
    const overrides = Object.fromEntries([...launches].filter(([id]) => ['codex', 'claude', 'pi', 'gemini', 'opencode'].includes(id)).map(([id, runtime]) => [id, runtime.command]));
    const found = await discover({ deps: { ...deps, commands: { ...deps.commands, ...overrides } }, force });
    const profile = (id, runtime) => ({ agentId: id, agentManaged: true, defaults: { provider: null, model: null, thinking: null }, models: [], providers: [], thinkingLevels: [], modelThinkingLevels: {}, source: '沿用原助手的账号与模型配置', description: '通过 ACP 连接的本机助手', runtime, version: digest(JSON.stringify(runtime)).slice(0, 24) });
    const agents = found.agents.map(agent => {
      const runtime = launches.get(agent.id);
      if (!runtime) return agent;
      if (runtime.protocol !== 'acp') return { ...agent, profile: agent.profile ? { ...agent.profile, runtime } : agent.profile };
      const auth = ['configured', 'required'].includes(agent.auth?.status) ? agent.auth : { status: 'unknown' };
      return { ...agent, installed: true, version: runtime.version || agent.version, auth, execution: { supported: true, protocol: 'acp' }, profile: profile(agent.id, runtime) };
    });
    for (const entry of catalog.entries.filter(entry => entry.kind === 'acp' && entry.installed)) {
      const runtime = launches.get(entry.localAgentId);
      if (!runtime || runtime.protocol !== 'acp' || agents.some(agent => agent.id === entry.localAgentId)) continue;
      agents.push({ id: entry.localAgentId, name: entry.name, installed: true, version: entry.installedVersion, auth: { status: 'unknown' }, execution: { supported: true, protocol: 'acp' }, profile: profile(entry.localAgentId, runtime), setupUrl: entry.repository || '', loginCommandId: null });
    }
    return { ...found, agents };
  };
}
