import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {createPersonalServer} from './index.mjs';
import {syntheticPi} from '../../../dev/fixtures/conversation-pi.mjs';
let seq=0;const key=()=>`conversation-${++seq}`;
const profile={agentId:'pi',defaults:{provider:'synthetic',model:'model-a',thinking:'off'},models:[{provider:'synthetic',id:'model-a',reasoning:false,thinkingLevels:['off']}],providers:['synthetic'],thinkingLevels:['off'],version:'synthetic-v1'};
async function fixture(t,extra={}) {
 const cli=await syntheticPi(t),events=new EventEmitter();
 const app=await createPersonalServer({dataDir:join(cli.directory,'data'),port:0,assistantManager:false,localAgentDeps:cli.deps,
  discoverLocalAgents:async()=>({checkedAt:new Date().toISOString(),agents:[{id:'pi',name:'Pi',installed:true,auth:{status:'configured'},execution:{supported:true},profile}]}),onChange:()=>events.emit('change'),...extra});
 await app.listen();t.after(()=>app.close());
 const api=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${app.address().port}/api${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify({...body,clientId:key()}):undefined});return {status:r.status,body:await r.json()};};
 const wait=(id,predicate)=>new Promise((resolve,reject)=>{const done=()=>{const thread=app.store.get('thread',id);if(predicate(thread)){clearTimeout(timer);events.off('change',done);resolve(thread);}};const timer=setTimeout(()=>{events.off('change',done);reject(new Error(JSON.stringify(app.store.get('thread',id)?.runs)));},8000);events.on('change',done);done();});
 await api('/contacts');const contact=(await api('/contacts',{kind:'agent',name:'Writer',handle:key(),instructions:'Be concise',binding:{type:'local',localAgentId:'pi'}})).body;
 const chat=(await api('/chats',{kind:'direct',memberIds:[contact.id]})).body;
 const send=async(text,id=chat.id)=>{const response=await api(`/threads/${id}/messages`,{text});assert.equal(response.status,200);return wait(id,t=>t.runs.at(-1)&&['completed','blocked','unknown'].includes(t.runs.at(-1).status));};
 const calls=async()=>{try{return (await readFile(cli.trace,'utf8')).trim().split('\n').map(JSON.parse);}catch{return [];}};
 return {app,api,wait,send,calls,chat,contact,cli};
}
test('ordinary tool-enabled contact cold resumes with only the new message, independent handles and safe public diagnostics',async t=>{
 const f=await fixture(t);const first=await f.send('First synthetic message');assert.equal(first.runs[0].status,'completed',JSON.stringify(first.runs[0]));
 const second=await f.send('Second synthetic message');assert.equal(second.runs[1].status,'completed');
 const calls=await f.calls(),contexts=calls.map(c=>JSON.parse(c.input.split('<untrusted_thread_context>\n')[1].split('\n</untrusted_thread_context>')[0]));
 assert.deepEqual(contexts[1].messages.map(m=>m.text),['Second synthetic message']);assert.equal(second.runs[1].contextDispatch.mode,'delta');assert.equal(second.runs[1].contextDispatch.retainedMessageCount,2);
 assert.notEqual(calls[0].token,calls[1].token);assert.equal(calls[0].args[calls[0].args.indexOf('--session')+1],calls[1].args[calls[1].args.indexOf('--session')+1]);
 const other=(await f.api('/contacts',{kind:'agent',name:'Editor',handle:key(),instructions:'Edit',binding:{type:'local',localAgentId:'pi'}})).body;
 const chat=(await f.api('/chats',{kind:'direct',memberIds:[other.id]})).body;await f.send('Another contact',chat.id);
 const third=(await f.calls())[2];assert.notEqual(third.args[third.args.indexOf('--session')+1],calls[0].args[calls[0].args.indexOf('--session')+1]);
 const publicThread=(await f.api(`/threads/${f.chat.id}`)).body;assert.ok(!JSON.stringify(publicThread).includes('session.jsonl'));assert.ok(!JSON.stringify(publicThread).includes(calls[1].token));
});
test('publication failure preserves receipt and reconciliation publishes the original result with no second model dispatch',async t=>{
 const f=await fixture(t);const save=f.app.store.saveArtifact.bind(f.app.store);let crash=true;
 f.app.store.saveArtifact=(...args)=>{if(crash){crash=false;throw new Error('synthetic publication crash');}return save(...args);};
 const failed=await f.send('Only send once');assert.equal(failed.runs[0].status,'unknown');assert.equal((await f.calls()).length,1);
 const r=await f.api(`/threads/${f.chat.id}/reconcile`,{runId:failed.runs[0].id});assert.equal(r.status,200);
 const recovered=await f.wait(f.chat.id,t=>t.runs[0].status==='completed');assert.equal(recovered.messages.filter(m=>m.role==='assistant').length,1);assert.equal((await f.calls()).length,1);
});
test('missing transcript after unknown dispatch cannot be retried, reconciled into new file, or bypassed by a later message',async t=>{
 const f=await fixture(t);f.app.store.saveArtifact=()=>{throw new Error('synthetic publication failure');};
 const first=await f.send('First');assert.equal(first.runs[0].status,'unknown');const session=f.app.store.list('conversation_session')[0];assert.ok(session);
 const {rm}=await import('node:fs/promises');await rm(session.file);
 assert.equal((await f.api(`/threads/${f.chat.id}/retry`,{runId:first.runs[0].id})).status,409);
 assert.equal((await f.api(`/threads/${f.chat.id}/messages`,{text:'Second'})).status,409);
 assert.equal((await f.api(`/threads/${f.chat.id}/reconcile`,{runId:first.runs[0].id})).status,200);
 const second=await f.wait(f.chat.id,t=>t.runs[0].status==='unknown');assert.equal((await f.calls()).length,1);
 assert.ok(!JSON.stringify(second.runs[0]).includes('session.jsonl'));
});

test('silent tool reads remain private dependencies, and revocation rebuilds before future use',async t=>{
 const {executeLocalAgent,conversationPiCapability}=await import('./local-agents.mjs');let f,source;
 f=await fixture(t,{conversationPiCapability,executeLocalAgent:async input=>{
  const result=await executeLocalAgent(input);
  const context=JSON.parse(input.prompt.split('<untrusted_thread_context>\n')[1].split('\n</untrusted_thread_context>')[0]);
  if(context.messages.find(m=>m.id===context.currentMessageId)?.text.includes('[SILENCE]')){const runId=input.conversationSession.manifest.id,threadId=input.conversationSession.session.threadId,tools=f.app.worker.options.chatTools;
   tools.capture({thread:{id:threadId},run:{id:runId}},[tools.snapshot(f.app.store.require('thread',source.id))]);}
  return result;
 }});
 const human=(await f.api('/contacts',{kind:'human',name:'Listener',handle:key()})).body;
 source=(await f.api('/chats',{kind:'group',title:'Shared source',memberIds:[f.contact.id,human.id]})).body;
 const first=await f.send('[SILENCE]');assert.equal(first.runs[0].status,'completed');assert.equal(first.messages.filter(m=>m.role==='assistant').length,0);
 assert.ok(f.app.store.list('conversation_session')[0].chatToolReads.some(x=>x.roomId===source.id));
 const second=await f.send('After silence');assert.equal(second.runs[1].contextDispatch.mode,'delta');assert.ok(second.messages.at(-1).chatToolReads.some(x=>x.roomId===source.id));
 // Removing the listener revokes the original source snapshot, even though no public output exposed it in round one.
 const update=await f.api(`/chats/${source.id}`,{version:source.version,memberIds:[f.contact.id],title:'Source changed'});assert.equal(update.status,200);
 const third=await f.send('After revocation');assert.equal(third.runs[2].status,'completed');assert.equal(third.runs[2].contextDispatch.mode,'rebuild');
 const last=(await f.calls()).at(-1);const context=JSON.parse(last.input.split('<untrusted_thread_context>\n')[1].split('\n</untrusted_thread_context>')[0]);assert.ok(!context.messages.some(m=>m.role==='assistant'));assert.ok(!third.messages.at(-1).chatToolReads.some(x=>x.roomId===source.id));
});

test('queued causal turns, separate group sessions and rejoining membership epochs never reuse hidden history',async t=>{
 const f=await fixture(t);
 await f.api(`/threads/${f.chat.id}/messages`,{text:'Queued one'});await f.api(`/threads/${f.chat.id}/messages`,{text:'Queued two'});
 const done=await f.wait(f.chat.id,t=>t.runs.length===2 && t.runs.every(r=>r.status==='completed'));
 const calls=await f.calls();assert.ok(!calls[0].input.includes('Queued two'));assert.ok(!calls[1].input.includes('Queued one'));
 const human=(await f.api('/contacts',{kind:'human',name:'Listener',handle:key()})).body;
 const group=(await f.api('/chats',{kind:'group',title:'Group',memberIds:[f.contact.id,human.id]})).body;
 const first=await f.send('Group secret before rejoin',group.id);assert.equal(first.runs[0].status,'completed');
 const groupCall=(await f.calls()).at(-1);assert.notEqual(groupCall.args[groupCall.args.indexOf('--session')+1],calls[0].args[calls[0].args.indexOf('--session')+1]);
 const removed=await f.api(`/chats/${group.id}`,{version:group.version,memberIds:[human.id]});assert.equal(removed.status,200);
 const joined=await f.api(`/chats/${group.id}`,{version:removed.body.version,memberIds:[human.id,f.contact.id]});assert.equal(joined.status,200);
 const next=await f.send('After rejoin',group.id);assert.equal(next.runs[1].status,'completed');assert.equal(next.runs[1].contextDispatch.mode,'rebuild');assert.ok(!(await f.calls()).at(-1).input.includes('Group secret before rejoin'));
});

test('startup adopts only the original completed receipt and rolls back acknowledgement when publication fails',async t=>{
 const f=await fixture(t),save=f.app.store.saveArtifact.bind(f.app.store);
 f.app.store.saveArtifact=()=>{throw new Error('synthetic crash');};const first=await f.send('Restart original');
 assert.equal(first.runs[0].inputReceipt.state,'supplied');assert.equal(f.app.store.list('conversation_session')[0].state,'reconcile_required');
 f.app.store.saveArtifact=save;f.app.store.updateThread(f.chat.id,thread=>{thread.runs[0].status='running';});f.app.store.recover();
 assert.equal(f.app.store.require('thread',f.chat.id).runs[0].status,'queued');f.app.worker.kick();
 const done=await f.wait(f.chat.id,t=>t.runs[0].status==='completed');assert.equal(done.runs[0].inputReceipt.state,'acknowledged');assert.equal((await f.calls()).length,1);
});

test('prepared input cannot fall back to stateless execution when capability changes across restart',async t=>{
 const f=await fixture(t);f.app.worker.closed=true;
 await f.api(`/threads/${f.chat.id}/messages`,{text:'Prepared only'});
 f.app.store.updateThread(f.chat.id,t=>{t.runs[0].status='running';});const thread=f.app.store.require('thread',f.chat.id);
 await f.app.worker.prepareConversation(thread,thread.runs[0],true);
 f.app.store.recover();f.app.worker.options.conversationPiCapability=async()=>null;f.app.worker.closed=false;f.app.worker.kick();
 const done=await f.wait(f.chat.id,t=>t.runs[0].status==='blocked');assert.match(done.runs[0].error,/能力已改变/);assert.equal((await f.calls()).length,0);
});

test('permission revocation during CLI preflight stops before any model dispatch',async t=>{
 const f=await fixture(t),original=f.cli.deps.spawn;let armed=false,revoked=false;
 f.app.worker.options.localAgentDeps.spawn=(command,args,opts)=>{
  // The immutable manifest exists only after the worker capability probe. Revoke during the later real adapter preflight.
  if(armed && !revoked && args.includes('--version') && f.app.store.list('conversation_input').some(x=>x.state==='prepared')){
   revoked=true;f.app.store.updateThread(f.chat.id,thread=>{thread.members.find(m=>m.contactId===f.contact.id).membershipId='synthetic-new-membership';});
  }
  return original(command,args,opts);
 };
 armed=true;const done=await f.send('Do not dispatch after revocation');assert.ok(revoked);assert.equal(done.runs[0].status,'blocked');assert.equal((await f.calls()).length,0);
 assert.equal(f.app.store.list('conversation_input')[0].state,'not_sent');
});

test('a crash after writing the empty owned header but before storing its receipt resumes the prepared input',async t=>{
 const f=await fixture(t);f.app.worker.closed=true;
 await f.api(`/threads/${f.chat.id}/messages`,{text:'Prepared header recovery'});
 f.app.store.updateThread(f.chat.id,t=>{t.runs[0].status='running';});const thread=f.app.store.require('thread',f.chat.id);
 await f.app.worker.prepareConversation(thread,thread.runs[0],true);
 const session=f.app.store.list('conversation_session')[0];delete session.receipt;f.app.store.put('conversation_session',session);
 f.app.store.recover();f.app.worker.closed=false;f.app.worker.kick();
 const done=await f.wait(f.chat.id,t=>['completed','blocked','unknown'].includes(t.runs[0].status));assert.equal(done.runs[0].status,'completed',done.runs[0].error);assert.equal((await f.calls()).length,1);
});

test('cancelled dispatched Pi input remains unknown and blocks replay after the owned process exits',async t=>{
 const f=await fixture(t);f.cli.deps.env.SYNTHETIC_HANG='1';
 await f.api(`/threads/${f.chat.id}/messages`,{text:'Cancel this dispatched attempt'});
 const live=await f.wait(f.chat.id,t=>Boolean(t.runs[0]?.progress));
 await f.api(`/threads/${f.chat.id}/cancel`,{runId:live.runs[0].id});
 const done=await f.wait(f.chat.id,t=>t.runs[0].status==='unknown' && !t.runs[0].cancelPending);
 assert.ok(done.runs[0].requiresReconciliation);assert.equal(done.messages.filter(m=>m.role==='assistant').length,0);
 assert.equal((await f.api(`/threads/${f.chat.id}/retry`,{runId:done.runs[0].id})).status,409);
 assert.equal((await f.api(`/threads/${f.chat.id}/reconcile`,{runId:done.runs[0].id})).status,200);
 await f.wait(f.chat.id,t=>t.runs[0].status==='unknown');assert.equal((await f.calls()).length,1);
});
