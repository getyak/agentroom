import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createPersonalServer} from './index.mjs';

const preset={kind:'preset',icon:'room',color:'teal'};
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k2w0AAAAASUVORK5CYII=';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'agentroom-group-avatar-'));
 let app;
 const start=async()=>{
  app=await createPersonalServer({dataDir:dir,port:0,discoverLocalAgents:async()=>({agents:[]}),codexCommand:'/missing-group-avatar-agent'});
  await app.listen();
 };
 await start();
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const api=async(path,body)=>{
  const response=await fetch(`http://127.0.0.1:${app.address().port}/api${path}`,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
 };
 const person=(await api('/contacts',{kind:'human',name:'Avatar test person',handle:'avatar-person',clientId:randomUUID()})).body;
 const peer=(await api('/contacts',{kind:'human',name:'Second person',handle:'second-person',clientId:randomUUID()})).body;
 return {api,person,get store(){return app.store;},group:body=>api('/chats',{kind:'group',title:'Room study',memberIds:[person.id,peer.id],clientId:randomUUID(),...body}),restart:async()=>{await app.close();await start();}};
}

test('group portraits persist in the thread and sidebar summary through restart; reset keeps the conversation',async t=>{
 const f=await fixture(t);
 const created=await f.group({groupAvatar:preset});
 assert.equal(created.status,201);
 assert.deepEqual(created.body.groupAvatar,preset);
 const before=created.body;
 assert.deepEqual((await f.api('/bootstrap')).body.threads.find(x=>x.id===before.id).groupAvatar,preset);
 const update={version:before.version,groupAvatar:{kind:'image',dataUrl:png},clientId:randomUUID()};
 const saved=await f.api(`/chats/${before.id}`,update);
 assert.equal(saved.status,200);assert.deepEqual(saved.body.groupAvatar,update.groupAvatar);
 assert.deepEqual((await f.api(`/chats/${before.id}`,update)).body,saved.body);
 await f.restart();
 const restored=(await f.api(`/threads/${before.id}`)).body;
 assert.deepEqual(restored.groupAvatar,update.groupAvatar);
 assert.deepEqual((await f.api('/bootstrap')).body.threads.find(x=>x.id===before.id).groupAvatar,update.groupAvatar);
 const reset=await f.api(`/chats/${before.id}`,{version:restored.version,groupAvatar:null,clientId:randomUUID()});
 assert.equal(reset.status,200);assert.equal(reset.body.groupAvatar,null);
 for(const key of ['id','memberIds','members','messages','runs','decisions','responsePolicies'])assert.deepEqual(reset.body[key],before[key]);
});

test('an omitted avatar preserves old groups and existing group-version conflict protection',async t=>{
 const f=await fixture(t);
 const before=(await f.group({})).body;
 assert.equal(before.groupAvatar??null,null);
 const saved=await f.api(`/chats/${before.id}`,{version:before.version,groupAvatar:preset,clientId:randomUUID()});
 assert.deepEqual(saved.body.groupAvatar,preset);
 const stale=await f.api(`/chats/${before.id}`,{version:before.version,groupAvatar:null,clientId:randomUUID()});
 assert.equal(stale.status,409);
 const renamed=await f.api(`/chats/${before.id}`,{version:saved.body.version,title:'Renamed room',clientId:randomUUID()});
 assert.equal(renamed.status,200);assert.deepEqual(renamed.body.groupAvatar,preset);
});

test('unsupported icons, unsafe image sources, malformed and oversized PNGs do not mutate a group',async t=>{
 const f=await fixture(t);const before=(await f.group({})).body;
 const tooWide=Buffer.from(png.split(',')[1],'base64');tooWide.writeUInt32BE(50000,16);
 for(const groupAvatar of [
  {kind:'preset',icon:'missing',color:'teal'}, {kind:'preset',icon:'room',color:'red'},
  {kind:'image',dataUrl:'https://example.invalid/avatar.png'}, {kind:'image',dataUrl:'data:image/svg+xml;base64,PHN2Zy8+'},
  {kind:'image',dataUrl:'data:image/png;base64,not-a-picture'},
  {kind:'image',dataUrl:'data:image/png;base64,'+tooWide.toString('base64')},
  {kind:'image',dataUrl:'data:image/png;base64,'+Buffer.alloc(100000).toString('base64')},
  {kind:'preset',icon:'room',color:'teal',url:'https://example.invalid/'}, 'room', [],
 ]){
  const response=await f.api(`/chats/${before.id}`,{version:before.version,groupAvatar,clientId:randomUUID()});
  assert.equal(response.status,400);
  assert.equal((await f.api(`/threads/${before.id}`)).body.version,before.version);
 }
 const direct=await f.api('/chats',{kind:'direct',memberIds:[f.person.id],groupAvatar:preset,clientId:randomUUID()});
 assert.equal(direct.status,400);
});

test('changing and resetting a group portrait preserves historical messages and an accepted waiting decision',async t=>{
 const f=await fixture(t);const group=(await f.group({})).body;
 await f.api(`/threads/${group.id}/messages`,{text:'Synthetic saved conversation',clientId:randomUUID()});
 const before=f.store.get('thread',group.id),messageId=before.messages[0].id;
 before.runs=[{id:'run_avatar_preservation',status:'needs_input',messageId,contactId:f.person.id,conversationSnapshot:{kind:'group',title:before.title,version:before.version},contactSnapshot:{id:f.person.id,name:f.person.name},createdAt:before.createdAt}];
 before.decisions=[{id:'dec_avatar_preservation',kind:'provider_approval',runId:'run_avatar_preservation',state:'pending',version:1,title:'Synthetic waiting approval',choices:[{key:'continue',label:'Continue'}]}];
 before.status='needs_input';f.store.put('thread',before);
 let version=before.version;
 for(const groupAvatar of [preset,{kind:'image',dataUrl:png},null]){
  const updated=await f.api(`/chats/${group.id}`,{version,groupAvatar,clientId:randomUUID()});
  assert.equal(updated.status,200);assert.deepEqual(updated.body.groupAvatar,groupAvatar);version=updated.body.version;
  for(const field of ['messages','runs','decisions','artifacts','events','memberIds','members','responsePolicies','status'])assert.deepEqual(updated.body[field],before[field]);
 }
});
