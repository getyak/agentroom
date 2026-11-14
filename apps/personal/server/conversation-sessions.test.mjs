import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore } from './store.mjs';
import { ConversationSessions } from './conversation-sessions.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'conversation-ledger-'));
  const store = new PersonalStore(root); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const ledger = new ConversationSessions(store);
  const thread = { id: 'chat-one', kind: 'direct', memberIds: ['self','writer'], members: [{contactId:'self',membershipId:'self-1'},{contactId:'writer',membershipId:'writer-1'}], messages: [], runs: [] };
  const adapter = { id:'pi', version:'0.85.1', bindingFingerprint:'account-one' };
  const make = (id, text, more = {}) => {
    const message = { id, role:'user', text, attachments:[], reactions:[] };
    thread.messages.push(message);
    const run = { id:`run-${id}`, messageId:id, status:'running', contactId:'writer', contactSnapshot:{id:'writer',name:'Writer',instructions:'Write carefully'}, executionSnapshot:{agentId:'pi',provider:'fixture',model:'alpha'}, participantSnapshot:[{id:'self'},{id:'writer'}], participantMemberships:structuredClone(thread.members), memoryIds:[] };
    thread.runs.push(run); store.put('thread',thread);
    const context = {currentMessageId:id, agentIdentity:run.contactSnapshot,participants:run.participantSnapshot,conversation:{kind:thread.kind,title:'A chat'},messages:structuredClone(thread.messages), explicitMemories:[],...more};
    return {thread,run,context,adapter,canRead:()=>true};
  };
  const settle = (input, prepared, text = 'Answer') => {
    ledger.markSending(input.run.id);
    ledger.recordResult(input.run.id,{schema:1,sessionId:'backend',payloadHash:'receipt',fileHash:'file'});
    input.run.status='completed';
    const answer={id:`reply-${input.run.id}`,role:'assistant',contactId:input.run.contactId,text,attachments:[],reactions:[],runId:input.run.id};
    input.thread.messages.push(answer);
    store.transaction(()=>{ ledger.commit(input.thread,input.run); store.put('thread',input.thread); });
    return answer;
  };
  return {store,ledger,thread,adapter,make,settle};
}

test('second turn sends no acknowledged history, attachment, own output or unchanged memory', t=>{
  const f=fixture(t), first=f.make('m1','Remember the blue flag',{explicitMemories:[{id:'mem1',text:'Use Chinese'}]});
  first.context.messages[0].attachments=[{id:'a1',name:'notes',text:'x'.repeat(2048),citeAs:'#source-a1'}];
  f.thread.messages[0].attachments=structuredClone(first.context.messages[0].attachments);
  const p1=f.ledger.prepare(first); assert.equal(p1.manifest.mode,'bootstrap'); f.settle(first,p1,'I remember BLUE.');
  const second=f.make('m2','What flag?',{explicitMemories:[{id:'mem1',text:'Use Chinese'}]});
  const p2=f.ledger.prepare(second);
  assert.equal(p2.session.id,p1.session.id); assert.equal(p2.manifest.mode,'delta');
  assert.deepEqual(p2.context.messages.map(m=>m.id),['m2']); assert.deepEqual(p2.context.explicitMemories,[]);
  assert.equal(JSON.stringify(p2.context).includes('Remember the blue flag'),false);
  assert.equal(p2.manifest.retainedMessageCount,2);
});

test('different contact or chat never shares a backend handle',t=>{
  const f=fixture(t), first=f.make('m1','One'), p1=f.ledger.prepare(first); f.settle(first,p1);
  const second=f.make('m2','Two'); second.run.contactId='editor'; second.run.contactSnapshot={id:'editor',instructions:'Edit'};
  const p2=f.ledger.prepare(second); assert.notEqual(p2.session.id,p1.session.id);
  second.thread={...second.thread,id:'chat-two'}; second.run={...second.run,id:'run-other'};
  const p3=f.ledger.prepare(second); assert.notEqual(p3.session.id,p2.session.id);
});

test('changed persona, model, binding or membership starts a new generation',t=>{
  for(const change of [i=>{i.run.contactSnapshot.instructions='New role';},i=>{i.run.executionSnapshot.model='beta';},i=>{i.adapter={...i.adapter,bindingFingerprint:'other-account'};},i=>{i.thread.members[1].membershipId='writer-2';}]){
    const f=fixture(t), a=f.make('m1','One'), p=f.ledger.prepare(a); f.settle(a,p);
    const b=f.make('m2','Two'); change(b); const next=f.ledger.prepare(b);
    assert.notEqual(next.session.id,p.session.id); assert.equal(next.manifest.mode,'rebuild'); assert.equal(next.session.generation,2);
  }
});

test('removed or edited retained material invalidates the old model memory',t=>{
  for(const change of [i=>{i.context.messages=i.context.messages.filter(m=>m.id!=='m1');},i=>{i.context.messages[0].text='Corrected';}]){
    const f=fixture(t), a=f.make('m1','Private old source'), p=f.ledger.prepare(a); f.settle(a,p);
    const b=f.make('m2','Next'); change(b); const next=f.ledger.prepare(b);
    assert.notEqual(next.session.id,p.session.id); assert.equal(next.manifest.mode,'rebuild');
  }
});

test('an unknown dispatch cannot be bypassed by changing role or retrying the run',t=>{
  const f=fixture(t), a=f.make('m1','Send once'), p=f.ledger.prepare(a); f.ledger.markSending(a.run.id); f.ledger.fail(a.run.id);
  const b=f.make('m2','Next'); b.run.contactSnapshot.instructions='Changed';
  assert.throws(()=>f.ledger.prepare(b),e=>e.code==='conversation_reconcile_required');
  assert.throws(()=>f.ledger.prepare(a),e=>e.code==='conversation_reconcile_required');
  assert.equal(f.store.get('conversation_session',p.session.id).state,'reconcile_required');
});

test('a prepared manifest never changes when later history or config changes',t=>{
  const f=fixture(t), a=f.make('m1','Original'), p=f.ledger.prepare(a);
  a.context.messages[0].text='Changed';
  assert.throws(()=>f.ledger.prepare(a),e=>e.code==='conversation_input_changed');
  assert.equal(f.store.get('conversation_input',a.run.id).payloadHash,p.manifest.payloadHash);
});

test('silent turns retain tool-read dependencies and revalidate them on the next turn',t=>{
  const f=fixture(t), a=f.make('m1','Read privately'), p=f.ledger.prepare(a);
  f.ledger.markSending(a.run.id); f.ledger.recordResult(a.run.id,{schema:1,sessionId:'backend'});
  a.run.chatToolReads=[{source:'other-chat'}]; a.run.artifactReads=[{artifactId:'private-source'}]; a.run.status='completed';
  f.store.transaction(()=>f.ledger.commit(a.thread,a.run));
  const b=f.make('m2','Next'); const next=f.ledger.prepare(b);
  assert.deepEqual(next.session.chatToolReads,[{source:'other-chat'}]);
  const c=f.make('m3','After revoke'); c.canRead=()=>false;
  // A prepared but unsent turn has no backend effects, so supersede it explicitly.
  f.ledger.fail(b.run.id); const rebuilt=f.ledger.prepare(c);
  assert.notEqual(rebuilt.session.id,p.session.id); assert.deepEqual(rebuilt.session.chatToolReads,[]);
});

test('late earlier replies are included by ID rather than lost behind a timestamp cursor',t=>{
  const f=fixture(t), a=f.make('m1','One'), p=f.ledger.prepare(a); f.settle(a,p);
  const b=f.make('m2','Two'); b.context.messages.splice(1,0,{id:'late-other-agent',role:'assistant',contactId:'editor',text:'Late answer',attachments:[]});
  const next=f.ledger.prepare(b); assert.deepEqual(next.context.messages.map(m=>m.id),['late-other-agent','m2']);
});
