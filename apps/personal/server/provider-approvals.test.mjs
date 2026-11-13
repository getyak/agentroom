import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore } from './store.mjs';
import { Messenger } from './messenger.mjs';
import { ProviderApprovals } from './provider-approvals.mjs';

async function approvalFixture(t, options = {}) {
 const directory=await mkdtemp(join(tmpdir(),'agentroom-decision-regression-'));
 const store=new PersonalStore(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const connection={id:'con_regression',type:'a2a',name:'QA',url:'http://127.0.0.1:1234/a2a/regression'};store.put('connection',connection);
 let cards=[{id:'card',requestGeneration:'generation_1',revision:'revision_1',title:'Choose?',choices:[{key:'yes',label:'Yes'}],state:'pending',...options.card}];
 const calls=[];
 const sync=new ProviderApprovals(store,new Messenger(store),()=>{},()=>{}, {call:async(_connection,method,params)=>{
  if(method.endsWith('/list'))return {approvals:cards};calls.push(params);
  if(options.unknown)throw new Error('response lost');return {state:'accepted'};
 }});
 sync.register({connectionId:connection.id,instanceId:'regression',service:'grokbot'});
 await sync.tick();
 return {store,sync,calls,cards:()=>cards,setCards:next=>{cards=next;},thread:()=>store.list('thread')[0]};
}

test('a provider accepting a choice does not prove execution or verification',async t=>{
 const f=await approvalFixture(t);const thread=f.thread();
 f.sync.choose(thread,thread.decisions[0],{choice:'yes'});f.store.put('thread',thread);await f.sync.tick();
 const decision=f.thread().decisions[0];
 assert.equal(decision.deliveryState,'delivered');assert.equal(decision.actionState,'not_observed');assert.equal(decision.verificationState,'not_provided');
});

test('original-app-only requests reject local choices even when the provider includes options',async t=>{
 const f=await approvalFixture(t,{card:{originalAppOnly:true}});const thread=f.thread();
 assert.throws(()=>f.sync.choose(thread,thread.decisions[0],{choice:'yes'}),error=>error.code==='original_app_required');
 assert.equal(f.store.list('provider_answer').length,0);assert.equal(f.calls.length,0);
});

test('a changed pending request generation never inherits the old accepted answer',async t=>{
 const f=await approvalFixture(t);const thread=f.thread();const originalId=thread.decisions[0].id;
 f.sync.choose(thread,thread.decisions[0],{choice:'yes'});f.store.put('thread',thread);await f.sync.tick();
 f.setCards([{...f.cards()[0],requestGeneration:'generation_2',revision:'revision_2',title:'A new action?',choices:[{key:'new_yes',label:'New yes'}]}]);await f.sync.tick();
 const pending=f.thread().decisions.find(d=>d.state==='pending');
 assert.ok(pending);assert.notEqual(pending.id,originalId);assert.equal(pending.decision,null);
 assert.equal(f.thread().decisions.find(d=>d.id===originalId).decision.choice,'yes');
});

test('a normal resolved observation revision reconciles the same request without another response',async t=>{
 const f=await approvalFixture(t);const thread=f.thread();const originalId=thread.decisions[0].id;
 f.sync.choose(thread,thread.decisions[0],{choice:'yes'});f.store.put('thread',thread);await f.sync.tick();
 f.setCards([{...f.cards()[0],revision:'answered_revision',state:'resolved',source:'agentroom',choiceLabel:'Yes'}]);await f.sync.tick();
 assert.equal(f.thread().decisions.length,1);assert.equal(f.thread().decisions[0].id,originalId);assert.equal(f.calls.length,1);
 assert.equal(f.thread().decisions[0].actionState,'not_observed');assert.equal(f.thread().decisions[0].verificationState,'not_provided');
});

test('resolved elsewhere does not acknowledge an uncertain local answer',async t=>{
 const f=await approvalFixture(t,{unknown:true});const thread=f.thread();
 f.sync.choose(thread,thread.decisions[0],{choice:'yes'});f.store.put('thread',thread);await f.sync.tick();
 f.setCards([{...f.cards()[0],revision:'external_revision',state:'resolved',source:'original',choiceLabel:'No'}]);await f.sync.tick();
 assert.equal(f.store.list('provider_answer')[0].state,'unknown');assert.equal(f.thread().decisions[0].deliveryState,'unknown');assert.equal(f.calls.length,1);
 assert.equal(f.thread().decisions[0].choiceLabel,'No');
});

test('a queued answer is not dispatched after a fresh card changes its generation',async t=>{
 const f=await approvalFixture(t);const thread=f.thread();
 f.sync.choose(thread,thread.decisions[0],{choice:'yes'});f.store.put('thread',thread);
 f.setCards([{...f.cards()[0],requestGeneration:'new_generation',revision:'new_revision',title:'Changed action?'}]);
 await f.sync.tick();await f.sync.tick();
 assert.equal(f.calls.length,0);assert.equal(f.store.list('provider_answer')[0].state,'stale');
 assert.equal(f.thread().decisions.find(d=>d.providerRequestGeneration==='new_generation').state,'pending');
});

test('existing cards have no fake run; exact rejection is queued once, external answers sync', async t => {
 const directory=await mkdtemp(join(tmpdir(),'agentroom-provider-'));
 const store=new PersonalStore(directory); t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const connection={id:'con_qa',type:'a2a',name:'QA',url:'http://127.0.0.1:1234/a2a/qa'};store.put('connection',connection);
 const messenger=new Messenger(store), calls=[];
 let cards=[{id:'card',revision:'rev1',title:'QA?',choices:[{key:'opaque-reject',label:'Reject QA'}],state:'pending'}];
 const sync=new ProviderApprovals(store,messenger,()=>{},()=>{}, {call:async (_c,method,params)=>{calls.push({method,params});return method.endsWith('/list')?{approvals:cards}:{state:'accepted'};}});
 sync.register({connectionId:connection.id,instanceId:'qa',service:'grokbot'});await sync.tick();
 let thread=store.list('thread')[0],decision=thread.decisions[0];assert.equal(thread.runs.length,0);assert.equal(thread.messages.length,0);
 const approval=messenger.approvals()[0];
 assert.equal(approval.contact.id,'connection_con_qa');
 assert.deepEqual(approval.source,{label:'Grok Bot',name:'QA',connectionId:'con_qa',botId:'qa',requestText:null,threadKind:'direct'});
 sync.choose(thread,decision,{choice:'opaque-reject',clientId:'request1'});store.put('thread',thread);
 await sync.tick();await sync.tick();assert.equal(calls.filter(c=>c.method.endsWith('/respond')).length,1);
 assert.equal(calls.find(c=>c.method.endsWith('/respond')).params.choice,'opaque-reject');
 cards=[{...cards[0],state:'resolved',choiceLabel:'Reject QA',source:'original'}];await sync.tick();
 decision=store.list('thread')[0].decisions[0];assert.equal(decision.state,'decided');assert.equal(decision.choiceLabel,'Reject QA');assert.equal(decision.providerSource,'original');
 thread=store.list('thread')[0];thread.runs.push({id:'run_qa',connectionId:connection.id,status:'completed',externalTaskId:'task_qa'});store.put('thread',thread);
 cards=[{...cards[0],id:'later_card',state:'pending',replyTo:'run_qa'}];await sync.tick();
 thread=store.get('thread',thread.id);assert.equal(thread.runs[0].status,'blocked');assert.equal(thread.decisions.at(-1).runId,'run_qa');
 cards=[{...cards[0],state:'resolved',replyTo:undefined}];await sync.tick();
 assert.equal(store.get('thread',thread.id).runs[0].phase,'reconcile');assert.equal(store.get('thread',thread.id).runs[0].status,'queued');
 assert.equal(calls.filter(c=>c.method.endsWith('/respond')).length,1);
});

test('approval sources distinguish same-name Bots, preserve accepted contacts, and tolerate removed records', async t => {
 const directory=await mkdtemp(join(tmpdir(),'agentroom-approval-source-'));
 const store=new PersonalStore(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const messenger=new Messenger(store);
 const sync=new ProviderApprovals(store,messenger,()=>{},()=>{});
 for(const suffix of ['a','b']) {
  const connection={id:`con_${suffix}`,type:'a2a',name:'New Bot',url:`http://127.0.0.1:1234/a2a/bot_${suffix}`};
  store.put('connection',connection);sync.register({connectionId:connection.id,instanceId:`bot_${suffix}`,service:'grokbot'});
  sync.project(store.get('native_approval_source',connection.id),connection,{id:'same-card',revision:'1',title:'同名请求',choices:[{key:'later',label:'稍后'}],state:'pending'});
 }
 const standalone=messenger.approvals();
 assert.deepEqual(standalone.map(a=>a.source.botId).sort(),['bot_a','bot_b']);
 assert.equal(new Set(standalone.map(a=>a.contact.id)).size,2);
 const thread=store.list('thread').find(item=>item.decisions[0].providerConnectionId==='con_a'),contact=store.get('contact','connection_con_a');
 thread.kind='group';thread.title='产品讨论';
 thread.messages.push({id:'request_a',role:'user',text:'整理项目计划',createdAt:new Date().toISOString()});
 thread.runs.push({id:'run_a',messageId:'request_a',connectionId:'con_a',contactId:contact.id,contactSnapshot:{...contact,name:'发起时的名称'}});
 thread.decisions[0].runId='run_a';store.put('thread',thread);
 store.put('contact',{...contact,name:'现在的名称'});
 const accepted=messenger.approvals().find(a=>a.threadId===thread.id);
 assert.equal(accepted.contact.name,'发起时的名称');
 assert.deepEqual(accepted.source,{label:'Grok Bot',name:'New Bot',connectionId:'con_a',botId:'bot_a',requestText:'整理项目计划',threadKind:'group'});
 store.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run('contact','connection_con_b');
 store.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run('connection','con_b');
 const missing=messenger.approvals().find(a=>a.source.botId==='bot_b');
 assert.equal(missing.contact,null);assert.equal(missing.source.name,null);
 // Public display metadata never projects the native source's private URL or credential binding.
 assert.ok(!JSON.stringify(missing.source).includes('http:'));
 assert.ok(!JSON.stringify(missing.source).includes('credential'));
});

test('restart never replays a response that may have reached the service; identity changes stop sync',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'agentroom-provider-'));const store=new PersonalStore(directory);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 store.put('connection',{id:'con_qa',type:'a2a',name:'QA',url:'http://127.0.0.1:1234/a2a/qa'});
 store.put('provider_answer',{id:'attempt',state:'sending'});
 const calls=[];const sync=new ProviderApprovals(store,new Messenger(store),()=>{},()=>{}, {call:async()=>{calls.push(1);return {approvals:[]};}});
 sync.register({connectionId:'con_qa',instanceId:'qa',service:'grokbot'});
 store.put('connection',{...store.get('connection','con_qa'),credentialVersion:2});await sync.tick();
 assert.equal(calls.length,0);assert.equal(store.get('provider_answer','attempt').state,'unknown');
});

test('HTTP decisions preserve exact options, reject stale versions and protect independent pending connections', async t => {
 const {createPersonalServer}=await import('./index.mjs');
 const directory=await mkdtemp(join(tmpdir(),'agentroom-provider-http-'));
 let cards=[{id:'card',revision:'v1',title:'QA?',choices:[{key:'not-approve-or-reject',label:'稍后'}],state:'pending'}];const responses=[];
 const app=await createPersonalServer({dataDir:directory,port:0,discoverLocalAgents:async()=>({agents:[]}),providerApprovals:{pollMs:1e6,call:async(_c,method,params)=>{
  if(method.endsWith('/list'))return {approvals:cards}; responses.push(params); return {state:'accepted'};
 }}});await app.listen();t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 app.store.put('connection',{id:'con_qa',type:'a2a',name:'QA',url:'http://127.0.0.1:1234/a2a/qa'});
 app.registerNativeSource({connectionId:'con_qa',instanceId:'qa',service:'grokbot'});await app.providerApprovals.tick();
 const request=async(path,body,method='POST')=>{const res=await fetch(`http://127.0.0.1:${app.address().port}${path}`,{method,headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,body:await res.json()};};
 const decision=app.store.list('thread')[0].decisions[0];
 assert.equal((await request('/api/connections/con_qa',null,'DELETE')).status,409);
 assert.equal((await request(`/api/decisions/${decision.id}`,{version:99,choice:'not-approve-or-reject',clientId:'request-stale'})).status,409);
 const body={version:decision.version,choice:'not-approve-or-reject',clientId:'request-valid'};
 assert.equal((await request(`/api/decisions/${decision.id}`,body)).status,200);await app.providerApprovals.tick();
 assert.equal((await request(`/api/decisions/${decision.id}`,body)).status,200);await app.providerApprovals.tick();assert.equal(responses.length,1);
 assert.equal(responses[0].choice,'not-approve-or-reject');
 cards=[{...cards[0],revision:'v2',state:'resolved',source:'original',choiceLabel:'稍后'}];await app.providerApprovals.tick();
 assert.equal((await request('/api/connections/con_qa',null,'DELETE')).status,200);
});
