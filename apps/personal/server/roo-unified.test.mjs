import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createPersonalServer } from './index.mjs';
const agent = id => ({ id, name: id, installed: true, auth: { status: 'configured' }, execution: { supported: true }, profile: { agentId: id, defaults: { provider: 'fixture', model: 'fixture-model', thinking: 'low' }, models: [], providers: ['fixture'], thinkingLevels: ['low'], version: 'v1' } });
async function setup(t, agents, options={}) {
 const dir = await mkdtemp(join(tmpdir(), 'roo-unified-')), changes = new EventEmitter(), requests = [];
 const app = await createPersonalServer({ dataDir: dir, port: 0, discoverLocalAgents: async () => ({ agents }), onChange: () => changes.emit('change'), executeLocalAgent: async request => {
  requests.push(request); return { markdown: requests.length === 1 ? '你好，我是阿屋。' : '你上一句说的是 hi。' };
 }, ...options });
 await app.listen(); t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
 const api = async (path, body) => { const r = await fetch(`http://127.0.0.1:${app.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };
 const completed = threadId => new Promise((resolve, reject) => { const timer = setTimeout(() => { changes.off('change', check); reject(new Error('Roo turn stalled')); }, 8000); const check = () => { const thread = app.store.require('thread', threadId); if (thread.runs.at(-1)?.status === 'completed') { clearTimeout(timer); changes.off('change', check); resolve(thread); } }; changes.on('change', check); check(); });
 return { app, api, completed, requests };
}
test('Roo automatically selects configured Gemini when Codex and Claude are unavailable', async t => {
 const s = await setup(t, [{ ...agent('codex'), auth: { status: 'required' } }, { ...agent('claude'), installed: false }, agent('gemini')]);
 const guide = (await s.api('/bootstrap')).body.workspace.guide;
 assert.equal(guide.agentId, 'gemini'); assert.equal(s.requests.length, 0);
});
test('setup messages and normal Roo DM share one intelligent conversation, including follow-up context and idempotency', async t => {
 const s = await setup(t, [agent('codex')]);
 const guide = (await s.api('/bootstrap')).body.workspace.guide;
 const state = (await s.api('/roomie')).body; assert.equal(state.threadId, guide.threadId);
 // A historical guideOnly preference must no longer strand ordinary conversation.
 s.app.store.put('setting', { ...s.app.store.require('setting', 'roomie'), guideOnly: true, agentId: null });
 const first = { clientId: 'roo-unified-hi', text: 'hi', agentId: '' };
 const accepted = await s.api('/roomie/messages', first); assert.equal(accepted.status, 200);
 const thread = await s.completed(guide.threadId);
 assert.equal(thread.messages.at(-1).text, '你好，我是阿屋。'); assert.equal(thread.runs.length, 1);
 await s.api('/roomie/messages', first); assert.equal(s.requests.length, 1);
 assert.equal((await s.api(`/threads/${guide.threadId}/messages`, { clientId: 'roo-unified-followup', text: '我上一句说了什么？' })).status, 200);
 const next = await s.completed(guide.threadId); assert.equal(next.messages.at(-1).text, '你上一句说的是 hi。');
 assert.match(s.requests[1].prompt, /hi/); assert.equal(s.app.store.list('roomie_job').length, 0);
 assert.equal(s.app.store.list('thread').filter(x => x.kind === 'direct' && x.memberIds.includes('agentroom_guide')).length, 1);
});
test('Roo backend selection persists for ordinary messages without replacing historical runs', async t => {
 const s = await setup(t, [agent('codex'), agent('claude')]); const state = (await s.api('/roomie')).body;
 const selected = await s.api('/roomie/actions', { clientId: 'roo-choose-claude', action: 'select_backend', agentId: 'claude' }); assert.equal(selected.status, 200);
 assert.equal((await s.api('/bootstrap')).body.workspace.guide.agentId, 'claude');
 await s.api(`/threads/${state.threadId}/messages`, { clientId: 'roo-claude-hi', text: 'hi' });
 const thread = await s.completed(state.threadId); assert.equal(thread.runs[0].localAgentId, 'claude');
 assert.equal((await s.api('/roomie')).body.settings.agentId, 'claude');
});
test('missing Roo backend reports unavailable without pretending a canned response is intelligence', async t => {
 const s = await setup(t, []); const state = (await s.api('/roomie')).body;
 const before = state.messages.length; const result = await s.api('/roomie/messages', { clientId: 'roo-no-backend', text: 'hi' });
 assert.equal(result.status, 409); assert.equal(result.body.error.code, 'agent_unavailable');
 assert.equal((await s.api('/roomie')).body.messages.length, before); assert.equal(s.requests.length, 0);
});

test('opening setup reuses an upgraded legacy Roo identity and its existing conversation', async t => {
 const s = await setup(t, [agent('codex')]);
 s.app.store.put('contact', { id:'agentroom_roomie',kind:'agent',systemRole:'roomie',name:'原来的小伴',handle:'roomie',instructions:'保留原身份',binding:null,configuration:{modelMode:'follow',thinking:'follow'},version:1 });
 const { Messenger } = await import('./messenger.mjs');
 const original = new Messenger(s.app.store).createChat({kind:'direct',memberIds:['agentroom_roomie']});
 original.purpose='roomie'; original.messages.push({id:'legacy-hi',role:'user',text:'原来的目标',contactId:'self'}); s.app.store.put('thread',original);
 s.app.store.put('setting',{id:'workspace-onboarding',completed:true});
 const state = (await s.api('/roomie')).body;
 assert.equal(state.threadId, original.id); assert.equal(s.app.store.get('contact','agentroom_guide'),null);
 assert.equal(state.messages[0].text,'原来的目标');
 assert.equal((await s.api('/roomie/messages',{clientId:'legacy-unified',text:'hi'})).status,200);
 assert.equal((await s.completed(original.id)).messages.at(-1).text,'你好，我是阿屋。');
});


test('a selected Gemini backend executes an actual ACP subprocess through the normal Roo queue', async t => {
 const dir=await mkdtemp(join(tmpdir(),'roo-gemini-acp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const script=join(dir,'gemini.cjs');
 await writeFile(script,`const rl=require('node:readline').createInterface({input:process.stdin});const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));rl.on('line',line=>{const q=JSON.parse(line);if(q.method==='initialize')send({id:q.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});else if(q.method==='session/new')send({id:q.id,result:{sessionId:'roo-fixture'}});else if(q.method==='session/prompt'){if(!q.params.prompt[0].text.includes('阿屋'))throw Error('Missing Roo identity');send({method:'session/update',params:{sessionId:'roo-fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Gemini ACP 回复'}}}});send({id:q.id,result:{stopReason:'end_turn'}});}});`);
 const gemini=agent('gemini');gemini.profile={...gemini.profile,agentManaged:true,runtime:{agentId:'gemini',protocol:'acp',command:process.execPath,args:[script],version:'1.0.0'}};
 const s=await setup(t,[gemini],{executeLocalAgent:undefined});
 const state=(await s.api('/roomie')).body;
 assert.equal((await s.api('/roomie/messages',{clientId:'roo-gemini-acp',text:'hi'})).status,200);
 const thread=await s.completed(state.threadId);assert.equal(thread.messages.at(-1).text,'Gemini ACP 回复');assert.equal(thread.runs[0].localAgentId,'gemini');
});

test('Roo accepts an explicit valid model to repair missing Codex defaults', async t => {
 const codex=agent('codex');codex.profile.defaults.model=null;
 const s=await setup(t,[codex]);await s.api('/roomie');
 const result=await s.api('/roomie/actions',{clientId:'roo-repair-fixed',action:'select_backend',agentId:'codex',configuration:{modelMode:'fixed',provider:'fixture',model:'explicit-model',thinking:'low'}});
 assert.equal(result.status,200);assert.equal((await s.api('/roomie')).body.contact.execution.model,'explicit-model');
});
