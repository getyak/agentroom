import { join } from 'node:path';
import { APIError, digest, id, now } from './store.mjs';

export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => digest(canonical(value));
const unique = values => [...new Map(values.map(value => [canonical(value), value])).values()];
const messageBody = message => ({ id:message.id, role:message.role, ...(message.contactId ? {contactId:message.contactId} : {}), text:message.text,
  attachments:(message.attachments || []).map(source => ({id:source.id,name:source.name,text:source.text,citeAs:source.citeAs || `#source-${source.id}`})) });

function materials(context) {
  const entries = [];
  for (const message of context.messages) {
    entries.push({key:`message:${message.id}`,hash:hash(messageBody(message))});
    for (const reaction of message.reactions || []) entries.push({key:`reaction:${message.id}:${reaction.contactId}:${reaction.emoji}`,hash:hash(reaction)});
  }
  for (const memory of context.explicitMemories || []) entries.push({key:`memory:${memory.id}`,hash:hash(memory)});
  return entries;
}

function scopeFor(thread, run, adapter) {
  return hash({ threadId:thread.id, contactId:run.contactId, adapter,
    binding:run.contactSnapshot?.binding || null, execution:run.executionSnapshot,
    persona:{id:run.contactId,instructions:run.contactSnapshot?.instructions,description:run.contactSnapshot?.description,goal:run.contactSnapshot?.goal},
    memberships:(thread.members || []).map(({contactId,membershipId,visibleAfterMessageId})=>({contactId,membershipId,visibleAfterMessageId})).sort((a,b)=>a.contactId.localeCompare(b.contactId)),
    members:[...(thread.memberIds || [])].sort(), policy:run.responsePolicy, imPolicy:run.imPolicy });
}

/** Private backend context ownership. Public runs receive summaries, never handles or payloads. */
export class ConversationSessions {
  constructor(store) { this.store=store; }

  summary(manifest) {
    return {mode:manifest.mode,messageCount:manifest.messageCount,retainedMessageCount:manifest.retainedMessageCount,
      bytes:manifest.bytes,receiptState:manifest.state, ...(manifest.reason ? {reason:manifest.reason} : {})};
  }

  publishSummary(manifest) {
    if (!this.store.get('thread',manifest.threadId)) return;
    this.store.updateThread(manifest.threadId,thread=>{
      const run=thread.runs.find(item=>item.id===manifest.id);
      if (run) run.contextDispatch=this.summary(manifest);
    });
  }

  prepare({thread,run,context,adapter,canRead=()=>true}) {
    const lane=digest(`${thread.id}\n${run.contactId}`), scopeKey=scopeFor(thread,run,adapter), fullHash=hash(context);
    const existing=this.store.get('conversation_input',run.id);
    if (existing) {
      if (existing.state!=='prepared') throw new APIError(409,'conversation_reconcile_required','原会话输入已有执行记录，必须先核查，不能再次提交');
      if (existing.fullHash!==fullHash || existing.scopeKey!==scopeKey) throw new APIError(409,'conversation_input_changed','已固定的会话输入或身份发生变化，本次没有重新发送');
      return {session:this.store.require('conversation_session',existing.sessionId),manifest:existing,context:existing.context};
    }
    const binding=this.store.get('conversation_binding',lane);
    let previous=binding && this.store.require('conversation_session',binding.sessionId);
    if (previous && ['awaiting_result','reconcile_required'].includes(previous.state)) throw new APIError(409,'conversation_reconcile_required','这个聊天的原会话结果尚未核查，不能用新会话绕过');
    const supplied=materials(context), current=new Map(supplied.map(item=>[item.key,item.hash]));
    let reason;
    if (previous && previous.scopeKey!==scopeKey) reason='identity_or_membership_changed';
    else if (previous && (!(previous.materials || []).every(item=>current.get(item.key)===item.hash) || !canRead(previous))) reason='context_visibility_changed';
    else if (previous && previous.state!=='ready') reason='session_unavailable';
    let session=previous;
    if (!session || reason) {
      if (previous) this.store.put('conversation_session',{...previous,state:'retired',retiredAt:now()});
      const sessionId=id('cs');
      session={id:sessionId,threadId:thread.id,contactId:run.contactId,lane,scopeKey,generation:(previous?.generation || 0)+1,
        adapter,state:'ready',directory:join(this.store.dataDir,'conversation-sessions',sessionId),materials:[],chatToolReads:[],artifactReads:[],createdAt:now()};
      session.file=join(session.directory,'session.jsonl'); session.workspace=join(session.directory,'work');
      this.store.put('conversation_session',session); this.store.put('conversation_binding',{id:lane,threadId:thread.id,sessionId});
    }
    const known=new Map(session.materials.map(item=>[item.key,item.hash]));
    const messages=context.messages.filter(message=>known.get(`message:${message.id}`)!==current.get(`message:${message.id}`));
    const delta=session.materials.length>0;
    const reactionUpdates=context.messages.filter(message=>!messages.some(item=>item.id===message.id)).flatMap(message=>(message.reactions || []).filter(reaction=>!known.has(`reaction:${message.id}:${reaction.contactId}:${reaction.emoji}`)).map(reaction=>({messageId:message.id,...reaction})));
    const next={...context,messages,explicitMemories:(context.explicitMemories || []).filter(memory=>known.get(`memory:${memory.id}`)!==current.get(`memory:${memory.id}`)),
      ...(delta ? {agentIdentity:{id:run.contactId,name:run.contactSnapshot.name,personaRevision:hash(run.contactSnapshot)},contextMode:'delta'} : {contextMode:'bootstrap'}),
      ...(reactionUpdates.length ? {reactionUpdates} : {})};
    const manifest={id:run.id,threadId:thread.id,sessionId:session.id,scopeKey,fullHash,context:next,payloadHash:hash(next),materials:supplied,
      mode:delta?'delta':previous?'rebuild':'bootstrap',...(reason?{reason}:{}),state:'prepared',messageCount:messages.length,
      retainedMessageCount:context.messages.length-messages.length,bytes:Buffer.byteLength(JSON.stringify(next)),preparedAt:now()};
    this.store.put('conversation_input',manifest); run.contextDispatch=this.summary(manifest); this.publishSummary(manifest);
    return {session,manifest,context:next};
  }

  bindPrompt(runId,prompt) {
    const manifest=this.store.require('conversation_input',runId);
    if(manifest.state!=='prepared' || manifest.promptHash && manifest.promptHash!==digest(prompt))throw new APIError(409,'conversation_input_changed','会话输入已经固定');
    const next={...manifest,promptHash:digest(prompt),bytes:Buffer.byteLength(prompt)};this.store.put('conversation_input',next);this.publishSummary(next);return next;
  }

  markSending(runId) {
    const manifest=this.store.require('conversation_input',runId), session=this.store.require('conversation_session',manifest.sessionId);
    if (manifest.state!=='prepared' || session.state!=='ready') throw new APIError(409,'conversation_reconcile_required','原会话输入不能再次派发');
    this.store.put('conversation_input',{...manifest,state:'sending',sentAt:now()});
    this.store.put('conversation_session',{...session,state:'awaiting_result',pendingRunId:runId});
    this.publishSummary({...manifest,state:'sending'});
  }

  recordResult(runId,receipt) {
    const manifest=this.store.require('conversation_input',runId);
    if (!['sending','unknown','result_received'].includes(manifest.state)) throw new APIError(409,'conversation_receipt_conflict','会话回执与原输入状态不符');
    this.store.put('conversation_input',{...manifest,state:'result_received',receipt});
    this.publishSummary({...manifest,state:'result_received'});
  }

  commit(thread,run) {
    const manifest=this.store.get('conversation_input',run.id); if (!manifest) return;
    if (manifest.state!=='result_received') throw new APIError(409,'conversation_receipt_missing','会话结果尚未通过原始回执核查');
    const session=this.store.require('conversation_session',manifest.sessionId);
    const ownOutputs=thread.messages.filter(message=>message.runId===run.id && message.role==='assistant').map(message=>({key:`message:${message.id}`,hash:hash(messageBody(message))}));
    this.store.put('conversation_session',{...session,state:'ready',pendingRunId:null,materials:unique([...manifest.materials,...ownOutputs]),
      chatToolReads:unique([...(session.chatToolReads || []),...(run.chatToolReads || [])]),
      artifactReads:unique([...(session.artifactReads || []),...(run.artifactReads || [])]),receipt:manifest.receipt,updatedAt:now()});
    const completed={...manifest,state:'completed',completedAt:now()}; this.store.put('conversation_input',completed); run.contextDispatch=this.summary(completed);
  }

  fail(runId) {
    const manifest=this.store.get('conversation_input',runId); if (!manifest || ['completed','not_sent'].includes(manifest.state)) return;
    const session=this.store.require('conversation_session',manifest.sessionId), unknown=manifest.state!=='prepared';
    this.store.put('conversation_input',{...manifest,state:unknown?'unknown':'not_sent'});
    this.store.put('conversation_session',{...session,state:unknown?'reconcile_required':'ready',pendingRunId:unknown?runId:null});
    this.publishSummary({...manifest,state:unknown?'unknown':'not_sent'});
  }

  assertCurrent(thread,run,context,canRead=()=>true) {
    const manifest=this.store.require('conversation_input',run.id), session=this.store.require('conversation_session',manifest.sessionId);
    const current=new Map(materials(context).map(item=>[item.key,item.hash]));
    if (scopeFor(thread,run,session.adapter)!==manifest.scopeKey || !manifest.materials.every(item=>current.get(item.key)===item.hash) || !canRead(session)) {
      throw new APIError(409,'conversation_visibility_changed','成员或资料权限已改变，本次会话结果没有发布');
    }
  }
}
