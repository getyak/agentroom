import { open, realpath, mkdir, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { digest } from './store.mjs';
import { guestCodexSession } from './codex-isolation.mjs';

export const CODEX_CONVERSATION_VERSION = '0.163.0';
export const CODEX_CONVERSATION_INPUT_LIMIT = 1_048_576;
const maxResumeBytes = 32 * 1024 * 1024;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const rollout = /^\d{4}\/\d{2}\/\d{2}\/rollout-[\dT-]+-([\da-f-]{36})\.jsonl$/i;
const failure = () => new Error('未取得与本次输入匹配的 Codex 会话回执');
const validFile = (file, threadId) => typeof file === 'string' && uuid.test(threadId) && rollout.exec(file)?.[1] === threadId;

// Keep only native history in this generation. Configuration, tool credentials,
// SQLite state and host authentication links belong to a fresh process each turn.
export async function codexConversationHome(session, deps) {
  const sessions = join(session.directory, 'sessions');
  await mkdir(sessions, { recursive:true, mode:0o700 });
  const guest = await guestCodexSession(session.directory, deps);
  try {
    await symlink(await realpath(sessions), join(guest.deps.home, 'sessions'));
    return guest;
  } catch (error) { await guest.close(); throw error; }
}

async function fileHash(session, file, threadId, maxBytes = Infinity) {
  if (!validFile(file, threadId)) throw failure();
  const directory = await realpath(session.directory);
  const path = join(directory, 'sessions', file);
  if (await realpath(path) !== path) throw failure();
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) throw failure();
    const hash = createHash('sha256');
    for await (const chunk of fd.createReadStream({ autoClose: false, end: info.size - 1 })) hash.update(chunk);
    const after = await fd.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw failure();
    return hash.digest('hex');
  } finally { await fd.close(); }
}

export async function codexFileReceipt(session, result, manifest) {
  const {threadId, turnId, file, markdown} = result;
  if (!uuid.test(turnId) || typeof markdown !== 'string' || !markdown.trim()) throw failure();
  return {schema:1, runId:manifest.id, promptHash:manifest.promptHash, threadId, turnId, file, markdown,
    outputHash:digest(markdown), fileHash:await fileHash(session,file,threadId)};
}

async function matchesCodexHistory(session, receipt, maxBytes) {
  try {
    return receipt?.schema === 1 && await fileHash(session, receipt.file, receipt.threadId, maxBytes) === receipt.fileHash;
  } catch { return false; }
}

export function validCodexHistory(session) {
  return matchesCodexHistory(session, session.receipt, maxResumeBytes);
}

export async function inspectCodexReceipt(session, manifest) {
  const receipt = manifest.receipt;
  if (!receipt || receipt.runId !== manifest.id || receipt.promptHash !== manifest.promptHash || !uuid.test(receipt.turnId) ||
    typeof receipt.markdown !== 'string' || digest(receipt.markdown) !== receipt.outputHash || !await matchesCodexHistory(session, receipt)) return {state:'unknown'};
  return {state:'completed',receipt,markdown:receipt.markdown};
}

// Pinned to the generated v2 protocol. The app-server owns the native thread.
// Only the completed turn is authoritative. Other RPC requests fail closed.
export function codexDialogue({conversation, selection, workspace, home, sessionsRoot, serviceTier, prompt, onProgress}) {
  const previous = conversation.session.receipt;
  const settings = {cwd:workspace,model:selection.model,modelProvider:selection.provider,approvalPolicy:'never',sandbox:'read-only',...(serviceTier ? {serviceTier} : {})};
  let phase='initialize', threadId, turnId, file, result;
  return {
    initial:{id:1,method:'initialize',params:{clientInfo:{name:'agentroom',version:'1'}}},
    receive(message, send) {
      if (message.method && message.id !== undefined) {
        send({id:message.id,error:{code:-32601,message:'Client action unavailable'}});
        return;
      }
      if (message.method === 'item/agentMessage/delta' && phase === 'turn' && message.params?.threadId === threadId &&
          message.params?.turnId === turnId && typeof message.params.delta === 'string') onProgress?.(message.params.delta);
      if (message.method === 'turn/completed' && phase === 'turn' && message.params?.threadId === threadId && message.params.turn?.id === turnId) {
        const {turn} = message.params;
        const answer = turn.items?.filter(item => item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null)).at(-1);
        if (turn.status !== 'completed' || turn.error || !answer?.text?.trim()) throw failure();
        result = {threadId,turnId,file,markdown:answer.text}; phase='done';
        return true;
      }
      if (message.method || message.id === undefined) return;
      const value = message.result;
      if (!value || message.error) throw failure();
      if (phase === 'initialize' && message.id === 1) {
        phase='thread'; send({method:'initialized'});
        send({id:2,method:previous?'thread/resume':'thread/start',params:{...settings,
          ...(previous ? {threadId:previous.threadId,excludeTurns:true} : {ephemeral:false})}});
      } else if (phase === 'thread' && message.id === 2) {
        const thread = value.thread;
        const tier = value.serviceTier;
        const tierMatches = !serviceTier || tier == null || tier === serviceTier || (serviceTier === 'fast' && tier === 'priority');
        if (!uuid.test(thread?.id) || thread.ephemeral !== false || thread.cwd !== workspace || value.cwd !== workspace ||
            value.approvalPolicy !== 'never' || value.sandbox?.type !== 'readOnly' || value.sandbox.networkAccess !== false ||
            value.model !== selection.model || value.modelProvider !== selection.provider || !tierMatches ||
            (selection.thinking && value.reasoningEffort !== selection.thinking) || typeof thread.path !== 'string') throw failure();
        threadId = thread.id;
        // A cold resume resolves the fresh home's symlink to the owned storage path.
        file = [join(home,'sessions'),sessionsRoot].map(root => relative(root,thread.path).split(sep).join('/')).find(path => validFile(path,threadId));
        if (!validFile(file,threadId) || previous && (threadId !== previous.threadId || file !== previous.file)) throw failure();
        conversation.beforeDispatch({provider:selection.provider,model:selection.model,threadId,file});
        phase='start'; send({id:3,method:'turn/start',params:{threadId,input:[{type:'text',text:prompt}]}});
      } else if (phase === 'start' && message.id === 3 && uuid.test(value.turn?.id) && value.turn.status === 'inProgress') {
        turnId=value.turn.id; phase='turn';
      } else throw failure();
    },
    result() { if (!result) throw failure(); return result; },
  };
}
