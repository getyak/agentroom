import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { digest } from './store.mjs';
import { codexDialogue, inspectCodexReceipt, codexFileReceipt, validCodexHistory } from './conversation-codex.mjs';
import { conversationCodexCapability } from './local-agents.mjs';
import { createPersonalServer } from './index.mjs';

const threadId = '00000000-1111-4222-8333-000000000001';
const turnId = '00000000-1111-4222-8333-000000000002';
const file = '2026/11/28/rollout-2026-11-28T01-00-00-' + threadId + '.jsonl';
function fixture(resume = false, ownedPath = false, serviceTier) {
  const sent = [], dispatched = [], workspace = '/fixture/work', home = '/fixture/home';
  const sessionsRoot = '/fixture/owned/sessions';
  const session = {workspace, ...(resume ? {receipt:{threadId,file}} : {})};
  const manifest = {id:'run-1',promptHash:digest('once')};
  const conversation = {session,manifest,beforeDispatch: data => dispatched.push(data)};
  const selection = {model:'model-a', provider:'openai', thinking:'low'};
  const client = codexDialogue({conversation, selection, workspace, home, sessionsRoot, serviceTier, prompt:'once'});
  const receive = message => client.receive(message, packet => sent.push(packet));
  const ready = () => {
    receive({id:1,result:{userAgent:'codex'}});
    receive({id:2,result:{thread:{id:threadId,cwd:workspace,ephemeral:false,path:ownedPath?join(sessionsRoot,file):join(home,'sessions',file)},cwd:workspace,
      approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},model:'model-a',modelProvider:'openai',reasoningEffort:'low',serviceTier:null}});
    receive({id:3,result:{turn:{id:turnId,status:'inProgress'}}});
  };
  return {client,ready,receive,sent,dispatched};
}
test('native resume selects the exact private thread and enforces read-only and denial before one turn', () => {
  const f=fixture(true,true); f.ready();
  const resume=f.sent.find(m=>m.method==='thread/resume');
  assert.equal(resume.params.threadId,threadId); assert.equal(resume.params.sandbox,'read-only'); assert.equal(resume.params.approvalPolicy,'never');
  assert.deepEqual(f.sent.filter(m=>m.method==='turn/start').map(m=>m.params.input),[[{type:'text',text:'once'}]]);
  assert.equal(f.dispatched.length,1);
  f.receive({method:'item/commandExecution/requestApproval',id:7,params:{threadId,turnId}});
  assert.ok(f.sent.at(-1).error || f.sent.at(-1).result?.decision==='decline');
  f.receive({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'Answer'}]}}});
  assert.equal(f.client.result().markdown,'Answer');
});
test('the resolved tier may be empty after the requested tier is handed to Codex', () => {
  const f=fixture(false,false,'fast'); f.ready();
  assert.equal(f.sent.find(message=>message.method==='thread/start').params.serviceTier,'fast');
  assert.equal(f.sent.filter(message=>message.method==='turn/start').length,1);
});
test('wrong thread, broadened sandbox and incomplete or unrelated output never produce a receipt', () => {
  const f=fixture(); f.ready();
  f.receive({method:'turn/completed',params:{threadId:'another',turn:{id:turnId,status:'completed',items:[{type:'agentMessage',text:'wrong'}]}}});
  assert.throws(()=>f.client.result());
  for(const change of [{model:'other'},{sandbox:{type:'workspaceWrite'}},{sandbox:{type:'readOnly',networkAccess:true}}]){
    const g=fixture(true); g.receive({id:1,result:{}});
    assert.throws(()=>g.receive({id:2,result:{thread:{id:threadId,cwd:'/fixture/work',path:join('/fixture/home/sessions',file),ephemeral:false},
      cwd:'/fixture/work',approvalPolicy:'never',model:'model-a',modelProvider:'openai',reasoningEffort:'low',sandbox:{type:'readOnly',networkAccess:false},...change}}));
    assert.equal(g.dispatched.length,0);
  }
});
test('publication recovery verifies original prompt, completed text and exact owned transcript', async t=>{
 const directory=await mkdtemp(join(tmpdir(),'codex-ledger-')); t.after(()=>rm(directory,{recursive:true,force:true}));
 const session={directory}; await mkdir(join(directory,'sessions','2026/11/28'),{recursive:true}); const filename=join(directory,'sessions',file);
 await writeFile(filename,'private synthetic backend state\n');
 const manifest={id:'run-1',promptHash:digest('once')};
 const receipt=await codexFileReceipt(session,{threadId,turnId,file,markdown:'Answer'},manifest);
 assert.equal((await inspectCodexReceipt(session,{...manifest,receipt})).markdown,'Answer');
 assert.equal((await inspectCodexReceipt(session,{...manifest,receipt:{...receipt,markdown:'changed'}})).state,'unknown');
 assert.equal((await inspectCodexReceipt(session,manifest)).state,'unknown');
 await writeFile(filename,'different backend state');
 assert.equal((await inspectCodexReceipt(session,{...manifest,receipt})).state,'unknown');
});

test('a rollout crossing the resume limit can still commit and reconcile the completed turn', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-large-rollout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = { directory };
  await mkdir(join(directory, 'sessions', '2026/11/28'), { recursive: true });
  const path = join(directory, 'sessions', file);
  await writeFile(path, 'synthetic rollout');
  await truncate(path, 32 * 1024 * 1024 + 1);
  const manifest = { id: 'run-1', promptHash: digest('once') };
  const receipt = await codexFileReceipt(session, { threadId, turnId, file, markdown: 'Answer' }, manifest);
  assert.equal((await inspectCodexReceipt(session, { ...manifest, receipt })).markdown, 'Answer');
  assert.equal(await validCodexHistory({ ...session, receipt }), false);
});

const nativeCodexFixture = `
import { appendFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2), trace = ${'TRACE_PATH'};
if (args.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using an API key'); process.exit(0); }
if (args[0] === 'features') { console.log('apps browser_use browser_use_external computer_use view_image multi_agent plugins remote_plugin in_app_browser shell_tool unified_exec hooks memories skill_search skip_host_skill_discovery'); process.exit(0); }
if (args[0] === 'mcp') { console.log('[]'); process.exit(0); }
if (args[0] === 'exec') {
  let inputBytes=0;
  for await (const chunk of process.stdin) inputBytes+=chunk.length;
  appendFileSync(trace,JSON.stringify({threadMethod:'exec',inputBytes})+'\\n');
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Compatibility reply'}}));
  console.log(JSON.stringify({type:'turn.completed'}));
  process.exit(0);
}
if (args[0] !== 'app-server' || !args.includes('--stdio')) process.exit(1);
const threadId = ${JSON.stringify(threadId)}, turnId = ${JSON.stringify(turnId)}, file = ${JSON.stringify(file)};
const output = reply => process.stdout.write(JSON.stringify(reply) + '\\n');
let threadMethod;
for await (const line of createInterface({input:process.stdin})) {
  const {id,method,params} = JSON.parse(line);
  if (method === 'initialize') output({id,result:{userAgent:'codex-fixture'}});
  if (method === 'thread/start' || method === 'thread/resume') {
    if (method === 'thread/resume' && params.threadId !== threadId) process.exit(2);
    threadMethod = method;
    const path = join(process.env.CODEX_HOME,'sessions',file);
    output({id,result:{thread:{id:threadId,cwd:params.cwd,path,ephemeral:false},cwd:params.cwd,
      approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},model:params.model,modelProvider:params.modelProvider,reasoningEffort:'low'}});
  }
  if (method === 'turn/start') {
    const input = params.input[0].text;
    const context = JSON.parse(input.split('<untrusted_thread_context>\\n')[1].split('\\n</untrusted_thread_context>')[0]);
    const request = context.messages.find(message => message.id === context.currentMessageId).text;
    appendFileSync(trace,JSON.stringify({threadMethod,threadId:params.threadId,input:input.slice(0,24000),broker:!!process.env.AGENTROOM_TOOL_TOKEN})+'\\n');
    output({id,result:{turn:{id:turnId,status:'inProgress'}}});
    const path = join(process.env.CODEX_HOME,'sessions',file);
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    appendFileSync(path,'synthetic transcript line\\n',{mode:0o600});
    if (request === '[DROP]') process.exit(0);
    if (request === '[HOLD]') {
      output({method:'item/agentMessage/delta',params:{threadId,turnId,delta:'partial synthetic text'}});
      continue;
    }
    const userMessage = {type:'userMessage',content:params.input};
    if (request === '[ECHO]') for (const phase of ['item/started','item/completed']) output({method:phase,params:{threadId,turnId,item:userMessage}});
    output({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[userMessage,{type:'agentMessage',phase:'final_answer',text:'Native reply'}]}}});
  }
}
`;

async function workerFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-worker-'));
  const trace = join(directory, 'calls.jsonl'), executable = join(directory, 'codex.mjs');
  const authDirectory = join(directory, '.codex');
  await mkdir(authDirectory);
  await writeFile(join(authDirectory, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic' }), { mode: 0o600 });
  await writeFile(join(authDirectory, 'config.toml'), 'model = "fixture-model"\nmodel_reasoning_effort = "low"\n');
  await writeFile(executable, nativeCodexFixture.replace('TRACE_PATH', JSON.stringify(trace)), { mode: 0o700 });
  const events = new EventEmitter();
  const profile = { agentId:'codex', defaults:{ provider:'openai', model:'fixture-model', thinking:'low' }, models:[], providers:['openai'], thinkingLevels:['low'], version:'fixture' };
  const options = { dataDir:join(directory, 'data'), port:0, assistantManager:false,
    localAgentDeps:{ home:directory, env:{ PATH:process.env.PATH, TMPDIR:process.env.TMPDIR }, commands:{ codex:executable }, spawn:(command,args,opts)=>spawn(process.execPath,[command,...args],opts) },
    discoverLocalAgents:async()=>({ checkedAt:new Date().toISOString(), agents:[{ id:'codex', name:'Codex', installed:true, auth:{status:'configured'}, execution:{supported:true}, profile }] }),
    onChange:()=>events.emit('change') };
  let app;
  let clientId = 0;
  const restart = async () => { await app?.close(); app = await createPersonalServer(options); await app.listen(); return app; };
  t.after(async () => { await app?.close(); await rm(directory, { recursive:true, force:true }); });
  await restart();
  const api = async (path,body) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api${path}`, {
      method:body ? 'POST' : 'GET', headers:{'content-type':'application/json'}, body:body ? JSON.stringify({...body,clientId:`codex-fixture-${++clientId}`}) : undefined,
    });
    return {status:response.status,body:await response.json()};
  };
  await api('/contacts');
  const {body:contact} = await api('/contacts',{kind:'agent',name:'Reviewer',handle:'native-reviewer',binding:{type:'local',localAgentId:'codex'}});
  const {body:chat} = await api('/chats',{kind:'direct',memberIds:[contact.id]});
  const wait = predicate => new Promise((resolve,reject)=>{
    const check = () => {
      const thread = app.store.require('thread',chat.id);
      if (predicate(thread)) { clearTimeout(timer); events.off('change',check); resolve(thread); }
    };
    const timer = setTimeout(()=>{
      events.off('change',check);
      const states = app.store.require('thread',chat.id).runs.map(run=>[run.status,run.cancelPending,run.contextDispatch?.receiptState,run.progress?.phase,run.error]);
      reject(new Error(`Codex fixture did not settle ${JSON.stringify(states)}`));
    },8000);
    events.on('change',check); check();
  });
  const send = async text => {
    assert.equal((await api(`/threads/${chat.id}/messages`,{text})).status,200);
    return wait(thread=>['completed','blocked','unknown'].includes(thread.runs.at(-1)?.status));
  };
  const calls = async () => (await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
  return { restart, api, send, wait, calls, chat, deps:options.localAgentDeps, configPath:join(authDirectory,'config.toml'), get app() { return app; } };
}

test('private Codex chat resumes one native thread after a worker restart', async t => {
  const fixture = await workerFixture(t);
  const first = await fixture.send('Original synthetic note');
  assert.equal(first.runs[0].contextDispatch?.mode,'bootstrap',first.runs[0].error);
  assert.equal(first.runs[0].status,'completed',first.runs[0].error);
  await fixture.restart();
  const second = await fixture.send('Follow up');
  assert.equal(second.runs[1].status,'completed',second.runs[1].error);
  assert.equal(second.runs[1].contextDispatch?.mode,'delta');
  const calls = await fixture.calls();
  assert.deepEqual(calls.map(call=>[call.threadMethod,call.threadId,call.broker]),[['thread/start',threadId,true],['thread/resume',threadId,true]]);
  assert.ok(!calls[1].input.includes('Original synthetic note'));
  assert.ok(!JSON.stringify((await fixture.api(`/threads/${fixture.chat.id}`)).body).includes(threadId));
});

test('Codex interruption after dispatch retains uncertainty and never submits a second turn', async t => {
  const fixture = await workerFixture(t);
  const failed = await fixture.send('[DROP]');
  const run = failed.runs[0];
  assert.equal(run.status,'unknown',run.error);
  assert.equal((await fixture.api(`/threads/${fixture.chat.id}/reconcile`,{runId:run.id})).status,200);
  await fixture.wait(thread=>thread.runs[0].status==='unknown');
  assert.equal((await fixture.calls()).length,1);
  assert.equal((await fixture.api(`/threads/${fixture.chat.id}/messages`,{text:'Later request'})).status,409);
});

test('a confirmed owner stop retires the native Codex generation and allows a new message', async t => {
  const fixture = await workerFixture(t);
  const path = `/threads/${fixture.chat.id}`;
  assert.equal((await fixture.api(`${path}/messages`,{text:'[HOLD]'})).status,200);
  const running = await fixture.wait(thread=>thread.runs[0]?.progress?.text==='partial synthetic text');
  const {id:runId} = running.runs[0];
  assert.equal((await fixture.api(`${path}/cancel`,{runId})).status,200);
  const stopped = await fixture.wait(thread=>!thread.runs[0].cancelPending && ['cancelled','unknown'].includes(thread.runs[0].status));
  assert.equal(stopped.runs[0].status,'cancelled');
  assert.equal(stopped.runs[0].contextDispatch?.receiptState,'cancelled');
  assert.equal((await fixture.api(`${path}/reconcile`,{runId})).status,409);
  const subsequent = await fixture.send('New owner request');
  assert.equal(subsequent.runs[1].status,'completed',subsequent.runs[1].error);
  assert.equal(subsequent.runs[1].contextDispatch?.mode,'rebuild');
  assert.deepEqual((await fixture.calls()).map(call=>call.threadMethod),['thread/start','thread/start']);
});

test('official Codex continuation preserves configured transport and rejects ambiguous overrides', async t => {
  const fixture = await workerFixture(t);
  const executionSnapshot = {provider:'openai',model:'fixture-model',thinking:'low'};
  const capability = deps=>conversationCodexCapability({deps,executionSnapshot});
  assert.ok(await capability(fixture.deps));
  for (const field of ['openai_base_url', 'chatgpt_base_url', '"openai_base_url"', '"openai\\u005fbase_url"', 'forced_login_method']) {
    await writeFile(fixture.configPath,`${field} = "synthetic-override"\n`);
    assert.equal(await capability(fixture.deps),null,field);
  }
  await writeFile(fixture.configPath,'model = "fixture-model"\nservice_tier = "fast"\n');
  assert.equal((await capability(fixture.deps))?.serviceTier,'fast');
  assert.equal(await capability({...fixture.deps,env:{...fixture.deps.env,OPENAI_BASE_URL:'https://example.invalid'}}),null);
});

test('long Codex inputs keep legacy compatibility while native prompt echoes stay bounded separately', async t => {
  const fixture = await workerFixture(t);
  const path = `/threads/${fixture.chat.id}/messages`;
  const attachments = sizes=>sizes.map((size,index)=>({name:`synthetic-${index}.txt`,text:'x'.repeat(size)}));
  assert.equal((await fixture.api(path,{text:'[ECHO]',attachments:attachments([390000,390000])})).status,200);
  const first = await fixture.wait(thread=>['completed','blocked','unknown'].includes(thread.runs[0]?.status));
  assert.equal(first.runs[0].status,'completed',first.runs[0].error);
  assert.equal(first.runs[0].contextDispatch?.mode,'bootstrap');
  assert.equal((await fixture.api(path,{text:'Large request',attachments:attachments([400000,400000,300000])})).status,200);
  const second = await fixture.wait(thread=>['completed','blocked','unknown'].includes(thread.runs[1]?.status));
  assert.equal(second.runs[1].status,'completed',second.runs[1].error);
  assert.equal(second.runs[1].contextDispatch,undefined);
  assert.equal(fixture.app.store.get('conversation_input',second.runs[1].id),null);
  assert.deepEqual((await fixture.calls()).map(call=>call.threadMethod),['thread/start','exec']);
});
