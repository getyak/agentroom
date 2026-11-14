import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createPersonalServer } from './index.mjs';
import { AssistantManagerError } from './assistant-manager.mjs';
const fixture = fileURLToPath(new URL('../../../dev/fixtures/acp-agent.mjs', import.meta.url));
const launch = (version, mode = 'chat') => ({ agentId: 'acp_synthetic', command: process.execPath, args: [fixture, mode], version, protocol: 'acp' });
const entry = { id: 'acp_synthetic', localAgentId: 'acp_synthetic', name: '合成 ACP 助手', description: 'fixture', kind: 'acp', installed: true, installedVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true, installSupported: true, source: 'managed', path: process.execPath, repository: null };
async function host(run) {
 const dataDir = await mkdtemp(join(tmpdir(), 'agentroom-assistant-api-')), events = new EventEmitter(); let server;
 const manager = { version: '1.0.0', busy: false, calls: [], snapshot: async () => ({ checkedAt: new Date().toISOString(), source: { status: 'fresh', checkedAt: new Date().toISOString() }, entries: [{...entry,installed:manager.installed!==false}], operations: [] }), launch: async () => manager.installed===false?null:launch(manager.version, manager.mode), close: async () => {}, hasPendingOperations: () => manager.busy,
  start: async body => { manager.calls.push(body); if(body.expectedVersion!=='2.0.0')throw new AssistantManagerError(409,'version_changed','版本已变化'); return { id: 'op_fixture', ...body, state: 'queued', version: body.expectedVersion }; } };
 try {
  server = await createPersonalServer({ dataDir, autoGroupNetwork: false, discoverLocalAgents: async () => ({ agents: [] }), assistantManager: manager, onChange: () => events.emit('change') });
  await server.listen();
  const api = async (path, body) => { const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
  const until = condition => new Promise((done, reject) => { const timer = setTimeout(() => { events.off('change', check); reject(new Error('fixture did not complete')); }, 8000); const check = () => { if(condition()){clearTimeout(timer);events.off('change',check);done();} }; events.on('change',check);check(); });
  await run({ server, manager, api, until });
 } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
}
test('installed ACP joins contacts, chats and persisted executable snapshots without changing accounts', () => host(async ({ server, manager, api, until }) => {
 const catalog = await api('/assistants');assert.equal(catalog.status,200);assert.equal(catalog.body.entries[0].latestVersion,'2.0.0');
 const inventory = await api('/integrations');assert.equal(inventory.body.agents[0].auth.status,'unknown');
 const contacts = await api('/contacts');const discovered=contacts.body.contacts.find(c=>c.id==='agent_acp_synthetic');assert.equal(discovered.added,false);assert.equal(discovered.availability,'ready');
 const adopted=await api('/contacts/local',{agentIds:['acp_synthetic'],clientId:'synthetic-adopt'});assert.equal(adopted.status,200);
 const created=await api('/chats',{kind:'direct',memberIds:['agent_acp_synthetic'],clientId:'synthetic-chat'});assert.equal(created.status,201);
 const sent=await api(`/threads/${created.body.id}/messages`,{text:'合成消息，只回复文字',clientId:'synthetic-send'});assert.equal(sent.status,200);
 manager.version='2.0.0';
 await until(()=>['completed','failed','blocked','unknown'].includes(server.store.require('thread',created.body.id).runs.at(-1)?.status));
 const diagnostic=server.store.require('thread',created.body.id).runs.at(-1);assert.equal(diagnostic.status,'completed',JSON.stringify(diagnostic));
 const saved=server.store.require('thread',created.body.id);assert.equal(saved.messages.at(-1).text,'ACP 合成回复');assert.equal(saved.runs.at(-1).executionSnapshot.runtime.version,'1.0.0');assert.equal(saved.runs.at(-1).localAgentIdentity.version,'1.0.0');
 const original=await api('/contacts');assert.equal(original.body.contacts.find(c=>c.id==='agent_acp_synthetic').id,discovered.id);
}));
test('install API rejects command injection and preserves version conflict errors', () => host(async ({ api, manager }) => {
 const rejected=await api('/assistants/install',{agentId:'acp_synthetic',action:'update',expectedVersion:'2.0.0',clientId:'a',command:'bad'});assert.equal(rejected.status,400);assert.equal(manager.calls.length,0);
 const conflict=await api('/assistants/install',{agentId:'acp_synthetic',action:'update',expectedVersion:'1.0.0',clientId:'b'});assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,'version_changed');
 const accepted=await api('/assistants/install',{agentId:'acp_synthetic',action:'update',expectedVersion:'2.0.0',clientId:'c'});assert.equal(accepted.status,202);assert.equal(accepted.body.version,'2.0.0');
}));
test('background installation blocks workspace switch/reset', () => host(async ({ api, manager, server }) => {
 manager.busy=true;const state=await api('/workspace/status');assert.ok(state.body.blockingRuns>=1);
 const prepared=await server.prepareWorkspaceSwitch();assert.ok(prepared.blockingRuns>=1);
 manager.busy=false;
}));
test('ACP permission denials remain visible in the persisted run status', () => host(async ({ server, manager, api, until }) => {
 manager.mode='chat-permissions';
 await api('/contacts');await api('/contacts/local',{agentIds:['acp_synthetic'],clientId:'permission-adopt'});
 const created=await api('/chats',{kind:'direct',memberIds:['agent_acp_synthetic'],clientId:'permission-chat'});
 await api(`/threads/${created.body.id}/messages`,{text:'只验证权限拒绝状态',clientId:'permission-send'});
 await until(()=>server.store.require('thread',created.body.id).runs.at(-1)?.status==='completed');
 assert.equal(server.store.require('thread',created.body.id).runs.at(-1).acpPermissionsDenied,1);
}));
test('a removed ACP executable becomes unavailable without deleting its identity or chat', () => host(async ({ server, manager, api }) => {
 await api('/contacts');await api('/contacts/local',{agentIds:['acp_synthetic'],clientId:'removed-adopt'});
 const created=await api('/chats',{kind:'direct',memberIds:['agent_acp_synthetic'],clientId:'removed-chat'});
 const contact=server.store.require('contact','agent_acp_synthetic');
 server.store.put('contact',{...contact,name:'我的伙伴',nameSource:'custom',instructions:'保留角色说明'});
 manager.installed=false;
 const contacts=await api('/contacts'),saved=contacts.body.contacts.find(c=>c.id===contact.id);
 assert.equal(saved.availability,'not_installed');assert.equal(saved.name,'我的伙伴');assert.equal(saved.instructions,'保留角色说明');assert.equal(saved.added,true);
 assert.equal(server.store.require('thread',created.body.id).memberIds.includes(contact.id),true);
}));
