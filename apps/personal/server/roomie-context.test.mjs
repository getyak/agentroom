import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalStore } from './store.mjs';
import { Messenger } from './messenger.mjs';
import { Roomie } from './roomie.mjs';
import { ChatTools } from './chat-tools.mjs';
import { EventEmitter } from 'node:events';

const profile={agentId:'pi',defaults:{provider:'fixture',model:'model-a',thinking:'low'},providers:['fixture'],models:[{provider:'fixture',id:'model-a',reasoning:true,thinkingLevels:['low']}],thinkingLevels:['low'],version:'v1'};
const detected={agents:[{id:'pi',name:'Pi',installed:true,auth:{status:'configured'},execution:{supported:true},profile}]};
const probe=request=>({markdown:JSON.stringify({status:'ok',challenge:request.prompt.match(/challenge: ([\w-]+)/)[1]})});
async function tool(request,name,args={}) {
 const r=await fetch(request.toolSession.endpoint,{method:'POST',headers:{authorization:`Bearer ${request.toolSession.token}`,'content-type':'application/json'},body:JSON.stringify({name,arguments:args,callId:crypto.randomUUID()})});
 return {status:r.status,...await r.json()};
}
async function fixture(t,analyze=async()=>({markdown:'{"reply":"","sources":[]}'})) {
 const dir=await mkdtemp(join(tmpdir(),'roomie-context-')),store=new PersonalStore(dir),messenger=new Messenger(store);let calls=0;
 const roomie=new Roomie(store,messenger,{bindingIdentity:async()=>'fixture',execute:async request=>{calls++;return request.prompt.includes('challenge:')?probe(request):analyze(request);}});
 const chats=new ChatTools(store,messenger);roomie.options.chatTools=chats;
 t.after(async()=>{await roomie.close();await chats.close();store.close();await rm(dir,{recursive:true,force:true});});
 roomie.snapshot(detected);const guide=store.require('contact',roomie.contactId);store.put('contact',{...guide,binding:{type:'local',localAgentId:'pi'}});
 const peer=messenger.saveContact({kind:'agent',name:'已有伙伴',handle:'existing-peer',description:'测试',instructions:'test',binding:{type:'local',localAgentId:'pi'},configuration:{modelMode:'follow',thinking:'follow'}});
 const joined=messenger.createChat({kind:'group',title:'共同项目',memberIds:[roomie.contactId,peer.id]}),privateGroup=messenger.createChat({kind:'group',title:'未加入的群',memberIds:[peer.id,messenger.saveContact({kind:'human',name:'本机联系人',handle:'local-person'}).id]});
 const add=(thread,text)=>store.updateThread(thread.id,t=>{t.messages.push({id:crypto.randomUUID(),role:'user',contactId:'self',recipientIds:[...t.memberIds],text,createdAt:new Date().toISOString()});});
 add(joined,'当前发布缺少一次兼容性核对');add(privateGroup,'OTHER_GROUP_SECRET');
 const enable=()=>roomie.action({action:'proactive',enabled:true},detected);
 const tick=()=>roomie.recommend(detected);
 const finish=async job=>{const thread=store.require('thread',job.threadId);await roomie.execute(thread,thread.runs[0],new AbortController().signal);return store.require('roomie_job',job.id);};
 return {store,messenger,roomie,chats,joined,privateGroup,add,enable,tick,finish,calls:()=>calls};
}
test('proactive consent is separate, changes queue once, cooldown and own suggestions do not loop',async t=>{
 const f=await fixture(t);assert.equal(await f.tick(),null);f.roomie.action({action:'monitor',enabled:true},detected);assert.equal(await f.tick(),null);assert.equal(f.calls(),0);
 f.enable();const before=f.roomie.snapshot(detected).messages.length,job=await f.tick();assert.ok(job);assert.equal(f.calls(),0);assert.equal(await f.tick(),null);
 await f.finish(job);assert.equal(f.roomie.snapshot(detected).messages.length,before);assert.equal(await f.tick(),null);
 f.add(f.joined,'已核对 Safari');assert.equal(await f.tick(),null);f.roomie.options.clock=()=>Date.now()+300001;assert.ok(await f.tick());
});
test('the harness reads actual visible group messages and environment; publishes traceable model advice',async t=>{
 let observed;
 const f=await fixture(t,async request=>{
  const directory=await tool(request,'roomie_groups');assert.equal(directory.status,200);
  assert.equal(directory.result.rooms.find(r=>r.id===f.privateGroup.id).canReadMessages,false);
  assert.equal((await tool(request,'roomie_read_group',{roomId:f.privateGroup.id})).status,403);
  const messages=await tool(request,'roomie_read_group',{roomId:f.joined.id});assert.equal(messages.status,200);observed=messages.result.messages;
  const env=await tool(request,'roomie_environment');assert.equal(env.status,200);assert.equal(env.result.executionVerified,false);
  assert.equal((await tool(request,'send_message',{text:'not allowed'})).status,403);
  return {markdown:JSON.stringify({reply:'先做兼容性核对，再安排发布。',sources:[{roomId:f.joined.id,messageId:observed[0].id}]})};
 });
 f.enable();const job=await f.tick();await f.finish(job);assert.match(observed[0].text,/兼容性/);
 const message=f.store.require('thread',f.roomie.settings().threadId).messages.at(-1);assert.match(message.text,/先做兼容性/);assert.ok(message.roomieObservation.sampledAt);assert.equal(message.role,'assistant');assert.ok(message.chatToolReads.some(dep=>dep.roomId===f.joined.id));
 assert.equal(f.chats.canReadMessage(message,['self',f.roomie.contactId]),true);assert.equal(f.chats.canReadMessage(message,['self','new-recipient']),false);
});
test('unread or invented sources cannot be presented as accurate recommendations',async t=>{
 const f=await fixture(t,async()=>({markdown:JSON.stringify({reply:'invented',sources:[{roomId:'fake',messageId:'fake'}]})}));f.enable();const job=await f.tick();await assert.rejects(()=>f.finish(job),/来源/);assert.equal(f.store.require('roomie_job',job.id).status,'failed');
 assert.ok(!f.roomie.snapshot(detected).messages.some(m=>m.text==='invented'));
});
test('disabling and re-enabling while analyzing revokes the original grant',async t=>{
 const f=await fixture(t,async request=>{await tool(request,'roomie_environment');f.roomie.action({action:'proactive',enabled:false},detected);f.enable();return {markdown:'{"reply":"stale advice","sources":[{"environment":true}]}'};});
 f.enable();const job=await f.tick();await assert.rejects(()=>f.finish(job),/授权|停止/);assert.ok(!f.roomie.snapshot(detected).messages.some(m=>m.text==='stale advice'));
});
test('membership or publication changes after a tool read prevent publication',async t=>{
 for(const change of ['membership','publication']) {
  const f=await fixture(t,async request=>{const read=await tool(request,'roomie_read_group',{roomId:f.joined.id});if(change==='membership')f.store.updateThread(f.joined.id,t=>{t.members.find(m=>m.contactId===f.roomie.contactId).membershipId='rejoined';});else f.store.put('play_room',{id:'published',threadId:f.joined.id,state:'published'});return {markdown:JSON.stringify({reply:'must not publish',sources:[{roomId:f.joined.id,messageId:read.result.messages[0].id}]})};});
  f.enable();const job=await f.tick();await assert.rejects(()=>f.finish(job));assert.ok(!f.roomie.snapshot(detected).messages.some(m=>m.text==='must not publish'));
 }
});
test('source edits during asynchronous identity checks are revalidated at publication',async t=>{
 const f=await fixture(t,async request=>{const read=await tool(request,'roomie_read_group',{roomId:f.joined.id});return {markdown:JSON.stringify({reply:'old advice',sources:[{roomId:f.joined.id,messageId:read.result.messages[0].id}]})};});
 let identities=0;f.roomie.options.bindingIdentity=async()=>{if(++identities===3)f.store.updateThread(f.joined.id,t=>{t.messages[0].text='已经完成兼容性核对';});return 'fixture';};
 f.enable();const job=await f.tick();await assert.rejects(()=>f.finish(job),/消息已经变化/);assert.ok(!f.roomie.snapshot(detected).messages.some(m=>m.text==='old advice'));
});
test('changing the guide backend while identity is resolving never accepts the old backend',async t=>{
 const f=await fixture(t);f.enable();f.roomie.options.bindingIdentity=async()=>{const guide=f.store.require('contact',f.roomie.contactId);f.store.put('contact',{...guide,binding:{type:'local',localAgentId:'codex'},version:guide.version+1});return 'fixture';};
 assert.equal(await f.tick(),null);assert.equal(f.store.list('roomie_job').length,0);assert.equal(f.calls(),0);
});
test('the real HTTP setting and periodic scheduler run observations through PersonalWorker without owner messages',async t=>{
 const {createPersonalServer}=await import('./index.mjs'),dir=await mkdtemp(join(tmpdir(),'roomie-observation-http-')),events=new EventEmitter();let analyses=0;
 const app=await createPersonalServer({dataDir:dir,port:0,roomieTickMs:10,discoverLocalAgents:async()=>detected,roomieBindingIdentity:async()=>'fixture',onChange:()=>events.emit('change'),executeLocalAgent:async request=>{
  if(request.prompt.includes('challenge:'))return probe(request);
  analyses++;assert.equal((await tool(request,'roomie_environment')).status,200);return {markdown:'{"reply":"先核对现有助手配置，再继续。","sources":[{"environment":true}]}'};
 }});await app.listen();t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const api=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${app.address().port}/api${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.status,200);return response.json();};
 const initial=await api('/roomie');const owners=app.store.require('thread',initial.threadId).messages.filter(m=>m.role==='user').length;
 await api('/roomie/actions',{clientId:'context-enabled',action:'proactive',enabled:true});
 await new Promise((resolve,reject)=>{const check=()=>{const observation=app.store.list('roomie_job').find(j=>j.observation);if(observation&&['completed','failed','interrupted'].includes(observation.status)){clearTimeout(timer);events.off('change',check);assert.equal(observation.status,'completed',observation.error);resolve();}};const timer=setTimeout(()=>{events.off('change',check);reject(new Error('observation queue stalled'));},5000);events.on('change',check);check();});
 const state=await api('/roomie');assert.equal(state.observation.status,'completed');assert.equal(state.job,null);assert.equal(analyses,1);assert.equal(app.store.require('thread',initial.threadId).messages.filter(m=>m.role==='user').length,owners);
 assert.ok(state.messages.at(-1).roomieObservation.sources[0].environment);await api('/roomie/actions',{clientId:'context-disabled',action:'proactive',enabled:false});
});
test('running observer notifications do not repeatedly force CLI discovery',async t=>{
 const {createPersonalServer}=await import('./index.mjs'),dir=await mkdtemp(join(tmpdir(),'roomie-discovery-budget-'));let discoveries=0,release,started;
 const analyzing=new Promise(resolve=>{started=resolve;}),hold=new Promise(resolve=>{release=resolve;});
 const app=await createPersonalServer({dataDir:dir,port:0,discoverLocalAgents:async()=>{discoveries++;return detected;},roomieBindingIdentity:async()=>'fixture',executeLocalAgent:async request=>{
  if(request.prompt.includes('challenge:'))return probe(request);started();await hold;return {markdown:'{"reply":"","sources":[]}'};
 }});await app.listen();t.after(async()=>{release();await app.close();await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.address().port}/api`;await fetch(base+'/roomie');await fetch(base+'/roomie/actions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:'budget-enable',action:'proactive',enabled:true})});
 let deadline;try{await Promise.race([analyzing,new Promise((_resolve,reject)=>{deadline=setTimeout(()=>reject(new Error('observer did not start')),5000);})]);}finally{clearTimeout(deadline);}const count=discoveries;
 // Observe one debounce window while the model is held. Absence of a probe is the behavior under test.
 app.worker.notify({kind:'progress'});await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(discoveries,count);
});
