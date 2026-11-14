import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, readFile, stat } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { digest, APIError } from './store.mjs';

export const PI_CONVERSATION_VERSION='0.85.1';
const MAX_FILE_BYTES=64*1024*1024;
const invalid=()=>new APIError(409,'conversation_session_invalid','原会话文件或回执无法核对，已保留原任务，没有重新发送');
const textOf=content=>typeof content==='string'?content:(content || []).filter(x=>x.type==='text').map(x=>x.text || '').join('');

async function directory(path) {
  if(!isAbsolute(path))throw invalid();
  const info=await lstat(path);
  if(!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077))throw invalid();
}
async function ownedFile(session) {
  if(session.file!==join(session.directory,'session.jsonl') || session.workspace!==join(session.directory,'work'))throw invalid();
  await directory(session.directory); await directory(session.workspace);
  const info=await lstat(session.file);
  if(!info.isFile() || info.isSymbolicLink() || info.nlink!==1 || (info.mode & 0o077) || info.size>MAX_FILE_BYTES)throw invalid();
  const handle=await open(session.file,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened=await handle.stat(); if(opened.dev!==info.dev || opened.ino!==info.ino)throw invalid();
    const bytes=await handle.readFile(); const after=await handle.stat();
    if(after.size!==bytes.length || after.mtimeMs!==opened.mtimeMs)throw invalid();
    return {bytes,info:opened};
  } finally {await handle.close();}
}
export async function createPiSession(session) {
  await mkdir(dirname(session.directory),{recursive:true,mode:0o700});
  await mkdir(session.directory,{mode:0o700}); await mkdir(session.workspace,{mode:0o700});
  const header={type:'session',version:3,id:randomUUID(),timestamp:new Date().toISOString(),cwd:session.workspace};
  const handle=await open(session.file,'wx',0o600);
  try {await handle.writeFile(JSON.stringify(header)+'\n');await handle.sync();}finally{await handle.close();}
  return (await validatePiSession(session)).receipt;
}
export async function validatePiSession(session,expected) {
  const {bytes,info}=await ownedFile(session);
  if(!bytes.length || bytes.at(-1)!==10)throw invalid();
  let entries;try{entries=bytes.toString('utf8').slice(0,-1).split('\n').map(line=>JSON.parse(line));}catch{throw invalid();}
  const [header,...rows]=entries;
  if(header.type!=='session' || header.version!==3 || typeof header.id!=='string' || header.cwd!==session.workspace || header.parentSession)throw invalid();
  if(expected && (info.dev!==expected.dev || info.ino!==expected.ino || header.id!==expected.sessionId || await realpath(session.directory)!==expected.directory || bytes.length<expected.bytes || digest(bytes.subarray(0,expected.bytes))!==expected.hash))throw invalid();
  const ids=new Set();let parent=null;
  for(const row of rows) {
    // Compaction/forks are deliberately unsupported. Never silently change retained context.
    if(!['message','custom','model_change','thinking_level_change'].includes(row.type) || typeof row.id!=='string' || ids.has(row.id) || row.parentId!==parent)throw invalid();
    ids.add(row.id);parent=row.id;
  }
  return {header,rows,receipt:{sessionId:header.id,directory:await realpath(session.directory),dev:info.dev,ino:info.ino,bytes:bytes.length,hash:digest(bytes)}};
}
export function completedPiTurn(rows,startId,{runId,payloadHash,provider,model,sessionId}) {
  const index=rows.findIndex(row=>row.id===startId),start=rows[index];
  if(index<0 || start.type!=='custom' || start.customType!=='agentroom_turn_started' || start.data?.schema!==1 || start.data.runId!==runId || start.data.payloadHash!==payloadHash)return null;
  const added=rows.slice(index+1).filter(row=>row.type==='message'),users=added.filter(row=>row.message?.role==='user'),final=added.at(-1);
  if(users.length!==1 || digest(textOf(users[0].message.content))!==payloadHash || final?.message?.role!=='assistant' || final.message.stopReason!=='stop')return null;
  const pending=new Set();
  for(const row of added) {
    const m=row.message;
    if(!['user','assistant','toolResult'].includes(m?.role))return null;
    if(m.role==='assistant') {
      if(m.provider!==provider || m.model!==model)return null;
      for(const block of m.content || [])if(block.type==='toolCall'){if(!block.id || pending.has(block.id))return null;pending.add(block.id);}
    } else if(m.role==='toolResult') {if(!pending.delete(m.toolCallId))return null;}
  }
  if(pending.size || (final.message.content || []).some(x=>x.type==='toolCall'))return null;
  return {schema:1,runId,payloadHash,sessionId,startedEntryId:startId,userEntryId:users[0].id,assistantEntryId:final.id,provider,model};
}
export async function inspectPiTurn(session,manifest,expected=session.receipt) {
  try {
    const parsed=await validatePiSession(session,expected),{rows,header}=parsed;
    const starts=rows.filter(row=>row.type==='custom' && row.customType==='agentroom_turn_started' && row.data?.runId===manifest.id);
    const done=rows.at(-1);
    if(starts.length!==1 || done?.type!=='custom' || done.customType!=='agentroom_turn_completed')return {state:'unknown'};
    const selection=manifest.selection;
    const proof=completedPiTurn(rows.slice(0,-1),starts[0].id,{runId:manifest.id,payloadHash:manifest.promptHash,provider:selection.provider,model:selection.model,sessionId:header.id});
    if(!proof || JSON.stringify(proof)!==JSON.stringify(done.data))return {state:'unknown'};
    const last=rows.find(row=>row.id===proof.assistantEntryId);
    const markdown=last.message.content.filter(x=>x.type==='text').map(x=>x.text || '').join('\n');
    if(!markdown.trim())return {state:'unknown'};
    return {state:'completed',markdown,receipt:parsed.receipt};
  } catch {return {state:'unknown'};}
}

/** Hash privately; never export credentials. Commands cannot be fingerprinted without executing them. */
export async function piBindingFingerprint({env=process.env,home=homedir()}={}) {
  const root=env.PI_CODING_AGENT_DIR || join(home,'.pi/agent'),files=[];
  const dynamic=value=>typeof value==='string'?value.trimStart().startsWith('!'):value && typeof value==='object' && Object.values(value).some(dynamic);
  try {
    for(const name of ['auth.json','settings.json','models.json']) {
      let value=null;try{const path=join(root,name),info=await stat(path);if(!info.isFile() || info.size>524288)return null;value=await readFile(path,'utf8');if(dynamic(JSON.parse(value)))return null;}catch(error){if(error.code!=='ENOENT')return null;}
      files.push([name,value]);
    }
    // Includes model-specific arbitrary env references, proxies and all transport overrides.
    const values=Object.entries(env).filter(([key])=>!key.startsWith('AGENTROOM_')).sort(([a],[b])=>a.localeCompare(b));
    return digest(JSON.stringify({root,files,env:values}));
  }catch{return null;}
}
