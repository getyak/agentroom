import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPersonalServer } from './index.mjs';

const action={toolName:'write_note',arguments:{target:'approved_note',text:'Exact approved content'}};
async function fixture(t) {
 const calls=[];let afterList;let schema={type:'object',required:['target','text'],properties:{target:{type:'string'},text:{type:'string'}}};
 const remote=http.createServer(async(request,response)=>{
  let body='';for await(const chunk of request)body+=chunk;const message=JSON.parse(body);
  if(message.method==='notifications/initialized'){response.writeHead(202);response.end();return;}
  let result;
  if(message.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'Isolated approval fixture',version:'1'}};
  else if(message.method==='tools/list')result={tools:[{name:'write_note',inputSchema:schema}]};
  else if(message.method==='tools/call'){calls.push({id:message.id,params:message.params});result={content:[{type:'text',text:'Fixture operation returned'}]};}
  else {response.writeHead(400);response.end();return;}
  response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  if(message.method==='tools/list'&&afterList){const once=afterList;afterList=null;once();}
 });
 await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));
 const directory=await mkdtemp(join(tmpdir(),'agentroom-decisions-http-')),events=new EventEmitter();
 const app=await createPersonalServer({dataDir:directory,port:0,discoverLocalAgents:async()=>({agents:[]}),onChange:()=>events.emit('change')});await app.listen();
 app.store.put('connection',{id:'exact_tools',type:'mcp',name:'Isolated tools',url:`http://127.0.0.1:${remote.address().port}/rpc`});
 t.after(async()=>{await app.close();remote.closeAllConnections();await new Promise(resolve=>remote.close(resolve));await rm(directory,{recursive:true,force:true});});
 const api=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${app.address().port}/api${path}`,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 const wait=(id,predicate)=>new Promise((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(timer);events.off('change',check);};
  const check=()=>{const thread=app.store.get('thread',id);if(thread&&predicate(thread)){cleanup();resolve(thread);}};
  const timer=setTimeout(()=>{cleanup();reject(new Error('Isolated approval fixture did not reach the expected state'));},5000);
  events.on('change',check);check();
 });
 const start=()=>api('/threads',{text:'Write exactly this note',mode:'connection',connectionId:'exact_tools',action,clientId:randomUUID()});
 return {app,api,wait,start,calls,setSchema:value=>{schema=value;},afterNextList:callback=>{afterList=callback;}};
}

test('HTTP approval, exact-operation reuse, and revocation share the durable worker path',async t=>{
 const f=await fixture(t),created=await f.start();const first=await f.wait(created.body.id,thread=>thread.status==='needs_input');
 const displayed=await f.api(`/threads/${first.id}`),decision=displayed.body.decisions[0];
 assert.equal(decision.capabilities.canRepeat,true);assert.equal(f.calls.length,0);
 assert.equal((await f.api(`/decisions/${decision.id}`,{choice:'approve',grantDuration:'conversation_exact',version:decision.version,clientId:randomUUID()})).status,200);
 await f.wait(first.id,thread=>thread.status==='completed');
 await f.api(`/threads/${first.id}/messages`,{text:'Do the same exact step again',mode:'connection',connectionId:'exact_tools',action,clientId:randomUUID()});
 const second=await f.wait(first.id,thread=>thread.runs.length===2&&thread.status==='completed');
 assert.equal(second.decisions[1].decision.basis,'grant');assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].id,f.calls[1].id);
 const current=(await f.api(`/threads/${first.id}`)).body.decisions[0];assert.equal(current.authorization.remaining,8);
 assert.equal((await f.api(`/decisions/${current.id}`,{action:'revoke',version:current.version,clientId:randomUUID()})).status,200);
 await f.api(`/threads/${first.id}/messages`,{text:'A later step needs a new authorization',mode:'connection',connectionId:'exact_tools',action,clientId:randomUUID()});
 await f.wait(first.id,thread=>thread.runs.length===3&&thread.status==='needs_input');assert.equal(f.calls.length,2);
});

test('a changed live tool contract cannot execute an older preview',async t=>{
 const f=await fixture(t),created=await f.start();const pending=await f.wait(created.body.id,thread=>thread.status==='needs_input');
 f.setSchema({type:'object',required:['target','text','new_required_field']});
 const decision=pending.decisions[0];await f.api(`/decisions/${decision.id}`,{choice:'approve',version:decision.version,clientId:randomUUID()});
 const stopped=await f.wait(pending.id,thread=>['blocked','failed'].includes(thread.status));
 assert.match(stopped.runs[0].error,/工具声明已改变/);assert.equal(f.calls.length,0);assert.equal(f.app.store.list('decision_attempt').length,0);
});

test('automatic grant reuse rediscovers tool declarations immediately before claim',async t=>{
 const f=await fixture(t),created=await f.start();const first=await f.wait(created.body.id,thread=>thread.status==='needs_input');
 const decision=first.decisions[0];await f.api(`/decisions/${decision.id}`,{choice:'approve',grantDuration:'conversation_exact',version:decision.version,clientId:randomUUID()});
 await f.wait(first.id,thread=>thread.status==='completed');
 f.afterNextList(()=>f.setSchema({type:'object',required:['target','text','changed_contract']}));
 await f.api(`/threads/${first.id}/messages`,{text:'Same step, while the live declaration changes',mode:'connection',connectionId:'exact_tools',action,clientId:randomUUID()});
 await f.wait(first.id,thread=>thread.runs.length===2&&['completed','blocked','failed'].includes(thread.status));
 assert.equal(f.calls.length,1);assert.equal(f.app.store.list('decision_attempt').length,1);
});

test('failed explicit readback and successful local evidence checks remain separate facts',async t=>{
 const f=await fixture(t);const verifiedAction={...action,verification:{toolName:'write_note',arguments:action.arguments,expected:{path:'/structuredContent/value',equals:'expected_value'}}};
 const created=await f.api('/threads',{text:'Verify an exact synthetic expected value',mode:'connection',connectionId:'exact_tools',action:verifiedAction,clientId:randomUUID()});
 const pending=await f.wait(created.body.id,thread=>thread.status==='needs_input'),decision=pending.decisions[0];
 await f.api(`/decisions/${decision.id}`,{choice:'approve',version:decision.version,clientId:randomUUID()});
 await f.wait(pending.id,thread=>thread.status==='blocked');const view=(await f.api(`/threads/${pending.id}`)).body.decisions[0];
 assert.equal(view.facts.verification,'failed');assert.equal(view.facts.verificationScope,'mcp_explicit_readback');assert.equal(view.facts.localArtifactVerification,'verified');
 assert.equal(f.calls.length,2);
});
