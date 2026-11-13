import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalStore } from './store.mjs';
import { Decisions } from './decisions.mjs';

const owner={type:'owner'};
const spec={operationType:'mcp',title:'Send the approved text',summary:'Exact operation',preview:'{}',payload:{toolName:'send',arguments:{to:'recipient_a',text:'Approved text'}},schemaFingerprint:'catalog_version_1'};
async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'agentroom-decisions-'));const store=new PersonalStore(directory);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 store.put('connection',{id:'connection',type:'mcp',name:'QA tools',url:'http://127.0.0.1:1234/mcp'});
 store.put('thread',{id:'thread',title:'QA task',messages:[],runs:[],decisions:[],events:[],createdAt:new Date().toISOString()});
 let clock=Date.parse('2026-11-13T10:00:00Z');const decisions=new Decisions(store,{clock:()=>clock});
 const run=(id='run_1')=>store.updateThread('thread',thread=>{thread.runs.push({id,status:'running',mode:'connection',connectionId:'connection',messageId:`message_${id}`});thread.messages.push({id:`message_${id}`,role:'user',text:'Perform this exact step'});});
 const prepare=(id='run_1',value=spec)=>{run(id);return decisions.request('thread',id,value);};
 const answer=(decision,extra={})=>decisions.respond(decision.id,{version:decision.version,choice:'approve',clientId:`answer_${decision.id}`,...extra},owner);
 const finish=id=>store.updateThread('thread',thread=>{const run=thread.runs.find(r=>r.id===id);Object.assign(run,{status:'completed',deliveryState:'delivered',actionState:'completed',verificationState:'not_provided'});decisions.executor.observe(thread,run);});
 return {store,decisions,prepare,answer,run,finish,setClock:value=>{clock=value;}};
}

test('one durable request owns versioned, idempotent answers and a frozen exact effect',async t=>{
 const f=await fixture(t);const decision=f.prepare();
 assert.equal(f.decisions.request('thread','run_1',spec).id,decision.id);
 assert.throws(()=>f.decisions.request('thread','run_1',{...spec,payload:{toolName:'send',arguments:{to:'other'}}}),error=>error.code==='effect_changed');
 const body={version:decision.version,choice:'approve',clientId:'stable_answer_1'};
 const result=f.decisions.respond(decision.id,body,owner);
 assert.deepEqual(f.decisions.respond(decision.id,body,owner),result);
 assert.throws(()=>f.decisions.respond(decision.id,{...body,choice:'reject'},owner),error=>error.code==='idempotency_conflict');
 assert.throws(()=>f.decisions.respond(decision.id,{...body,clientId:'opposite_answer',choice:'reject'},owner),error=>error.code==='version_conflict');
 assert.equal(f.store.list('decision_attempt').length,0);
 const effect=f.decisions.executor.claim('thread','run_1','catalog_version_1');
 assert.deepEqual(effect.payload.arguments,{to:'recipient_a',text:'Approved text'});
 assert.equal(f.store.list('decision_attempt').length,1);
 assert.throws(()=>f.decisions.executor.claim('thread','run_1','catalog_version_1'),error=>error.code==='unknown_execution');
});

test('only the authenticated owner entry can decide or grant authority',async t=>{
 const f=await fixture(t);const decision=f.prepare();
 for(const actor of [undefined,{type:'agent'},{type:'remote_peer'}]) {
  assert.throws(()=>f.decisions.respond(decision.id,{version:1,choice:'approve',clientId:'untrusted_actor'},actor),error=>error.code==='not_approver');
 }
 assert.equal(f.store.require('thread','thread').decisions[0].state,'pending');
});

test('dispatch rejects changed identities, exact payloads, and discovered tool contracts',async t=>{
 const f=await fixture(t);const decision=f.prepare();f.answer(decision);
 assert.throws(()=>f.decisions.executor.claim('thread','run_1','changed_catalog'),error=>error.code==='tool_contract_changed');
 f.store.updateThread('thread',thread=>{thread.decisions[0].payload.arguments.to='unapproved_recipient';});
 assert.throws(()=>f.decisions.executor.claim('thread','run_1','catalog_version_1'),error=>error.code==='effect_changed');
 f.store.updateThread('thread',thread=>{thread.decisions[0].payload=structuredClone(spec.payload);});
 f.store.put('connection',{...f.store.require('connection','connection'),credentialVersion:2});
 assert.throws(()=>f.decisions.executor.claim('thread','run_1','catalog_version_1'),error=>error.code==='approval_identity_changed');
 assert.equal(f.store.list('decision_attempt').length,0);
});

test('an explicit conversation grant reuses only the same exact operation with a ten-call budget',async t=>{
 const f=await fixture(t);const first=f.prepare();f.answer(first,{grantDuration:'conversation_exact'});
 for(let number=1;number<=10;number++) {
  if(number>1)assert.equal(f.prepare(`run_${number}`).decision.basis,'grant');
  f.decisions.executor.claim('thread',`run_${number}`,'catalog_version_1');f.finish(`run_${number}`);
 }
 const eleventh=f.prepare('run_11');assert.equal(eleventh.state,'pending');
 const changed=f.prepare('run_changed',{...spec,payload:{toolName:'send',arguments:{to:'recipient_b',text:'Different text'}}});
 assert.equal(changed.state,'pending');assert.equal(f.store.list('decision_grant')[0].used,10);
});

test('expiry and revocation prevent future claims without cancelling an already claimed operation',async t=>{
 const f=await fixture(t);const first=f.prepare();f.answer(first,{grantDuration:'conversation_exact'});
 f.decisions.executor.claim('thread','run_1','catalog_version_1');
 const recorded=f.decisions.read({threadId:'thread'})[0];
 f.decisions.respond(first.id,{action:'revoke',version:recorded.version,clientId:'revoke_after_claim'},owner);
 assert.equal(f.store.require('thread','thread').runs[0].deliveryState,'sending');
 assert.equal(f.prepare('run_2').state,'pending');
 f.finish('run_1');
 const second=f.store.require('thread','thread').decisions.find(d=>d.runId==='run_2');f.answer(second,{grantDuration:'conversation_exact'});
 f.setClock(Date.parse('2026-11-13T11:00:01Z'));
 assert.throws(()=>f.decisions.executor.claim('thread','run_2','catalog_version_1'),error=>error.code==='grant_expired');
});

test('revocation committed before claim prevents the unsent operation',async t=>{
 const f=await fixture(t);const first=f.prepare();f.answer(first,{grantDuration:'conversation_exact'});
 const current=f.decisions.read({threadId:'thread'})[0];
 f.decisions.respond(first.id,{action:'revoke',version:current.version,clientId:'revoke_before_claim'},owner);
 assert.throws(()=>f.decisions.executor.claim('thread','run_1','catalog_version_1'),error=>['grant_revoked','inactive_decision'].includes(error.code));
 assert.equal(f.store.list('decision_attempt').length,0);
});

test('restart retains uncertain claims and cannot create a second attempt',async t=>{
 const f=await fixture(t);const first=f.prepare();f.answer(first);f.decisions.executor.claim('thread','run_1','catalog_version_1');
 const restored=new Decisions(f.store);
 assert.equal(f.store.list('decision_attempt')[0].state,'unknown');
 assert.throws(()=>restored.executor.claim('thread','run_1','catalog_version_1'),error=>error.code==='unknown_execution');
 assert.equal(f.store.list('decision_attempt').length,1);
});

test('a grant does not cross conversation, accepted audience, or executor identity',async t=>{
 const f=await fixture(t);const first=f.prepare();f.answer(first,{grantDuration:'conversation_exact'});f.decisions.executor.claim('thread','run_1','catalog_version_1');f.finish('run_1');
 f.store.updateThread('thread',thread=>{thread.runs.push({id:'other_agent',status:'running',mode:'connection',connectionId:'connection',contactId:'new_member',participantMemberships:[{contactId:'new_member',membershipId:'new_membership'}]});});
 assert.equal(f.decisions.request('thread','other_agent',spec).state,'pending');
});

test('dispatch never treats a grant for another frozen effect as authorization',async t=>{
 const f=await fixture(t);const first=f.prepare();f.answer(first,{grantDuration:'conversation_exact'});
 const other=f.prepare('other_effect',{...spec,payload:{toolName:'send',arguments:{to:'another_recipient'}}});f.answer(other);
 const grantId=f.store.list('decision_grant')[0].id;
 f.store.updateThread('thread',thread=>{thread.decisions.find(d=>d.id===other.id).grantId=grantId;});
 assert.throws(()=>f.decisions.executor.claim('thread','other_effect','catalog_version_1'),error=>error.code==='grant_scope_changed');
 assert.equal(f.store.list('decision_grant')[0].used,0);
});
