import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore, connectionIdentity } from './store.mjs';
import { Messenger } from './messenger.mjs';
import { syncNativeServices } from './native-services.mjs';

test('native recovery correlates the current tool round rather than an earlier message ID', async t => {
 const directory=await mkdtemp(join(tmpdir(),'agentroom-native-tool-round-'));
 const store=new PersonalStore(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const connection={id:'native_round',type:'a2a',name:'Synthetic native',url:'http://127.0.0.1:12345/a2a/bot'};
 store.put('connection',connection);store.put('native_approval_source',{id:connection.id,instanceId:'bot',identity:connectionIdentity(connection)});
 const messenger=new Messenger(store);messenger.sync({agents:[]});
 const thread=messenger.createChat({kind:'direct',memberIds:['connection_native_round']});
 thread.runs.push({id:'original',messageId:'owner_input',dispatchMessageId:'original_tools_1',mode:'connection',connectionId:connection.id,status:'unknown',phase:'dispatch',deliveryState:'unknown',finishedAt:'2026-11-11T00:00:00Z'});
 store.put('thread',thread);store.put('message_identity',{...connectionIdentity(connection),id:'original'});
 syncNativeServices(store,{port:12345,startedAt:'2026-11-12T00:00:00Z',instances:[],tasks:[{id:'earlier',instanceId:'bot',messageId:'original',state:'completed'},{id:'second_round',instanceId:'bot',messageId:'original_tools_1',state:'working'}]},()=>{});
 const run=store.require('thread',thread.id).runs[0];assert.equal(run.externalTaskId,'second_round');assert.equal(run.status,'unknown');
});

test('missing native instances retain identity and resolve only provably unsent requests', async t => {
 const directory=await mkdtemp(join(tmpdir(),'agentroom-native-state-'));
 const store=new PersonalStore(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const connection={id:'con_native',type:'a2a',name:'Synthetic Grok',url:'http://127.0.0.1:12345/a2a/bot'};
 store.put('connection',connection);
 store.put('native_approval_source',{id:connection.id,instanceId:'bot',identity:connectionIdentity(connection)});
 const messenger=new Messenger(store);messenger.sync({agents:[]});
 const thread=messenger.createChat({kind:'group',title:'Synthetic group',memberIds:['connection_con_native']});
 thread.messages.push({id:'message',role:'user',text:'Synthetic only'});
 thread.runs.push({id:'unsent',messageId:'message',mode:'connection',connectionId:connection.id,status:'unknown',deliveryState:'unknown',phase:'dispatch',requiresReconciliation:true,finishedAt:'2026-11-11T00:00:00Z'},
 {id:'accepted',messageId:'message',mode:'connection',connectionId:connection.id,status:'unknown',deliveryState:'unknown',phase:'dispatch',requiresReconciliation:true,finishedAt:'2026-11-11T00:00:00Z'},
 {id:'other',mode:'codex',status:'completed'});
 store.put('thread',thread);
 for(const run of thread.runs) if(run.connectionId) store.put('message_identity',{...connectionIdentity(connection),id:run.id});
 const changes=[];syncNativeServices(store,{port:12345,startedAt:'2026-11-12T00:00:00Z',instances:[],tasks:[{id:'original_receipt',instanceId:'bot',messageId:'accepted',state:'working'}]},event=>changes.push(event));
 const result=store.require('thread',thread.id);
 assert.equal(result.runs[0].status,'failed');assert.equal(result.runs[0].deliveryState,'not_sent');assert.equal(result.runs[0].requiresReconciliation,false);
 assert.equal(result.runs[1].status,'unknown');assert.equal(result.runs[1].externalTaskId,'original_receipt');
 assert.equal(result.runs[2].status,'completed');assert.equal(result.messages.length,1);
 const contact=messenger.contacts().find(c=>c.id==='connection_con_native');
 assert.equal(contact.availability,'disconnected');assert.equal(contact.avatarService,'grokbot');
 assert.ok(changes.some(event=>event.threadId===thread.id));
 syncNativeServices(store,{port:12345,startedAt:'2026-11-12T00:00:00Z',instances:[{id:'bot',service:'grokbot',status:'ready',avatarDataUrl:'data:image/png;base64,iVBORw0KGgo='}],tasks:[]},()=>{});
 assert.equal(messenger.contacts().find(c=>c.id===contact.id).availability,'ready');
 assert.equal(store.require('thread',thread.id).runs[1].status,'unknown');
 syncNativeServices(store,{port:12345,startedAt:'2026-11-12T00:00:00Z',instances:[],tasks:[]},()=>{});
 assert.equal(messenger.contacts().find(c=>c.id===contact.id).avatarDataUrl,'data:image/png;base64,iVBORw0KGgo=');
});

test('a different port or malformed snapshot cannot clear an unknown request', async t => {
 const directory=await mkdtemp(join(tmpdir(),'agentroom-native-scope-'));
 const store=new PersonalStore(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 store.put('connection',{id:'con_remote',type:'a2a',url:'http://127.0.0.1:12346/a2a/bot'});
 store.put('thread',{id:'thread',runs:[{id:'run',mode:'connection',connectionId:'con_remote',status:'unknown',deliveryState:'unknown'}]});
 syncNativeServices(store,{port:12345,startedAt:'2026-11-12T00:00:00Z',instances:[],tasks:[]},()=>{});
 assert.equal(store.require('thread','thread').runs[0].status,'unknown');
 assert.throws(()=>syncNativeServices(store,{port:0,instances:[],tasks:[]},()=>{}));
});


test('same-port custom connections and changed identities remain uncertain; current-process requests are not cleared', async t => {
 const directory=await mkdtemp(join(tmpdir(),'agentroom-native-boundary-'));
 const store=new PersonalStore(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const connection={id:'con_custom',type:'a2a',url:'http://127.0.0.1:12345/a2a/custom'};
 store.put('connection',connection);
 const run={id:'unknown',mode:'connection',connectionId:connection.id,status:'unknown',deliveryState:'unknown',phase:'dispatch',finishedAt:'2026-11-11T00:00:00Z'};
 store.put('message_identity',{...connectionIdentity(connection),id:run.id});
 store.put('thread',{id:'thread',runs:[run]});
 const snapshot={port:12345,startedAt:'2026-11-12T00:00:00Z',instances:[],tasks:[]};
 syncNativeServices(store,snapshot,()=>{});
 assert.equal(store.get('native_service_source',connection.id),null);
 assert.equal(store.require('thread','thread').runs[0].status,'unknown');
 store.put('native_approval_source',{id:connection.id,instanceId:'custom',identity:connectionIdentity(connection)});
 run.finishedAt='2026-11-12T00:00:01Z';store.put('thread',{id:'thread',runs:[run]});
 syncNativeServices(store,snapshot,()=>{});
 assert.equal(store.require('thread','thread').runs[0].status,'unknown');
 run.finishedAt='2026-11-11T00:00:00Z';store.put('thread',{id:'thread',runs:[run]});
 store.put('connection',{...connection,credentialVersion:2});
 syncNativeServices(store,snapshot,()=>{});
 assert.equal(store.require('thread','thread').runs[0].status,'unknown');
});
