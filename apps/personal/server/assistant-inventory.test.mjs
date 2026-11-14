import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantInventory } from './assistant-inventory.mjs';
import { resolveExecution } from './agent-profiles.mjs';
const runtime = { command: '/owned/versions/1/assistant', args: ['acp'], protocol: 'acp', version: '1.0.0', agentId: 'acp_test' };
const manager = { snapshot: async () => ({ entries: [{ localAgentId: 'acp_test', id: 'acp_test', kind: 'acp', installed: true, name: 'Test', installedVersion: '1.0.0' }] }), launch: async () => structuredClone(runtime) };
test('no manager preserves synthetic discovery exactly', async () => { const value = { agents: [], marker: true }; assert.equal(await assistantInventory({ discover: async () => value })(), value); });
test('installed registry assistants expose unknown auth and immutable execution coordinates', async () => {
 const result = await assistantInventory({ manager, discover: async () => ({ agents: [], checkedAt: 'now' }) })();
 assert.equal(result.agents.length, 1); const agent = result.agents[0];
 assert.equal(agent.auth.status, 'unknown'); assert.equal(agent.execution.protocol, 'acp');
 const snapshot = resolveExecution(agent.profile);
 runtime.version = '2.0.0'; assert.equal(snapshot.runtime.version, '1.0.0'); runtime.version = '1.0.0';
 assert.throws(() => resolveExecution(agent.profile, { modelMode: 'fixed', provider: 'x', model: 'y' }), /原助手管理/);
});
test('native ACP support preserves existing identity instead of adding a duplicate', async () => {
 const source = { ...manager, snapshot: async () => ({ entries: [{ localAgentId: 'gemini', kind: 'native', installed: true }] }) };
 const found = await assistantInventory({ manager: source, discover: async () => ({ agents: [{ id: 'gemini', name: 'Gemini CLI', installed: true, auth: { status: 'unsupported' }, execution: { supported: false } }] }) })();
 assert.equal(found.agents.length, 1); assert.equal(found.agents[0].id, 'gemini'); assert.equal(found.agents[0].auth.status, 'unknown'); assert.equal(found.agents[0].execution.supported, true);
});
