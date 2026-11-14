import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile, writeFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from './store.mjs';
import { createPiSession, validatePiSession, inspectPiTurn, piBindingFingerprint } from './conversation-pi.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'agentroom-pi-session-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const session={id:'cs_test',directory:join(directory,'cs_test'),file:join(directory,'cs_test/session.jsonl'),workspace:join(directory,'cs_test/work')};
  const receipt=await createPiSession(session); session.receipt=receipt; const manifest={id:'run_test',promptHash:digest('synthetic prompt'),selection:{provider:'synthetic',model:'model-a'}};
  return {session,receipt,manifest};
}
async function completed(f, {provider='synthetic',tool=false,complete=true}={}) {
  const header=JSON.parse((await readFile(f.session.file,'utf8')).trim());
  const rows=[{type:'custom',id:'s',parentId:null,customType:'agentroom_turn_started',data:{schema:1,runId:f.manifest.id,payloadHash:f.manifest.promptHash}},
    {type:'message',id:'u',parentId:'s',message:{role:'user',content:[{type:'text',text:'synthetic prompt'}]}}];
  if(tool)rows.push({type:'message',id:'tc',parentId:'u',message:{role:'assistant',provider,model:'model-a',stopReason:'toolUse',content:[{type:'toolCall',id:'tool1',name:'read_messages',arguments:{}}]}},{type:'message',id:'tr',parentId:'tc',message:{role:'toolResult',toolCallId:'tool1',content:[]}});
  rows.push({type:'message',id:'a',parentId:tool?'tr':'u',message:{role:'assistant',provider,model:'model-a',stopReason:'stop',content:[{type:'text',text:'synthetic answer'}]}});
  if(complete)rows.push({type:'custom',id:'c',parentId:'a',customType:'agentroom_turn_completed',data:{schema:1,runId:f.manifest.id,payloadHash:f.manifest.promptHash,sessionId:header.id,startedEntryId:'s',userEntryId:'u',assistantEntryId:'a',provider,model:'model-a'}});
  await appendFile(f.session.file,rows.map(x=>JSON.stringify(x)+'\n').join('')); return rows;
}

test('owned Pi transcript cold read verifies double receipt and original bytes without modifying the file',async t=>{
 const f=await fixture(t);await completed(f,{tool:true});const before=await readFile(f.session.file);const r=await inspectPiTurn(f.session,f.manifest,f.receipt);
 assert.equal(r.state,'completed');assert.equal(r.markdown,'synthetic answer');assert.deepEqual(await readFile(f.session.file),before);
 assert.equal((await validatePiSession(f.session,r.receipt)).receipt.sessionId,r.receipt.sessionId);
});
test('final assistant alone, missing file and malformed tail remain unknown and never create a new session',async t=>{
 const f=await fixture(t);await completed(f,{complete:false});assert.equal((await inspectPiTurn(f.session,f.manifest,f.receipt)).state,'unknown');
 await appendFile(f.session.file,'{truncated');assert.equal((await inspectPiTurn(f.session,f.manifest,f.receipt)).state,'unknown');
 await rm(f.session.file);assert.equal((await inspectPiTurn(f.session,f.manifest,f.receipt)).state,'unknown');await assert.rejects(readFile(f.session.file));
});
test('changed acknowledged prefix, changed inode, wrong provider, forks and symlinks reject exact resume',async t=>{
 for(const mode of ['prefix','inode','provider','fork','symlink']) {
  const f=await fixture(t);const rows=await completed(f,{provider:mode==='provider'?'other':'synthetic'});
  if(mode==='prefix')await writeFile(f.session.file,(await readFile(f.session.file,'utf8')).replace('"version":3','"version":2'));
  if(mode==='inode'){const bytes=await readFile(f.session.file);await rename(f.session.file,f.session.file+'.old');await writeFile(f.session.file,bytes,{mode:0o600});}
  if(mode==='fork')await appendFile(f.session.file,JSON.stringify({...rows[0],id:'fork',parentId:'u'})+'\n');
  if(mode==='symlink'){await rename(f.session.file,f.session.file+'.old');await symlink(f.session.file+'.old',f.session.file);}
  assert.equal((await inspectPiTurn(f.session,f.manifest,f.receipt)).state,'unknown',mode);
 }
});
test('binding fingerprints account for private env values and refuse dynamic credential commands',async t=>{
 const f=await fixture(t);const a=await piBindingFingerprint({home:f.session.directory,env:{SYNTHETIC_KEY:'a'}});
 const b=await piBindingFingerprint({home:f.session.directory,env:{SYNTHETIC_KEY:'b'}});assert.notEqual(a,b);assert.ok(!a.includes('SYNTHETIC'));
 const c=await piBindingFingerprint({home:f.session.directory,env:{AGENTROOM_PRIVATE_KEY:'account-a'}}),d=await piBindingFingerprint({home:f.session.directory,env:{AGENTROOM_PRIVATE_KEY:'account-b'}});assert.notEqual(c,d);
 const {mkdir}=await import('node:fs/promises');const dir=join(f.session.directory,'.pi/agent');await mkdir(dir,{recursive:true});await writeFile(join(dir,'models.json'),JSON.stringify({apiKey:'!synthetic-command'}));
 assert.equal(await piBindingFingerprint({home:f.session.directory,env:{}}),null);
});

import { executeLocalAgent, conversationPiCapability } from './local-agents.mjs';
import { syntheticPi } from '../../../dev/fixtures/conversation-pi.mjs';
test('adapter resumes only exact owned files, keeps explicit selection, and refreshes native tool credentials each round',async t=>{
 const f=await fixture(t),cli=await syntheticPi(t),capability=await conversationPiCapability({deps:cli.deps});assert.equal(capability.version,'0.85.1');f.session.adapter=capability;
 let dispatches=0;for(const [i,token] of ['synthetic-token-1','synthetic-token-2'].entries()) {
  const manifest={...f.manifest,id:'r'+i,promptHash:digest('synthetic prompt')};
  const result=await executeLocalAgent({id:'pi',prompt:'synthetic prompt',workspace:f.session.workspace,executionSnapshot:{provider:'synthetic',model:'model-a',thinking:'off'},deps:cli.deps,
   conversationSession:{session:f.session,manifest,beforeDispatch:()=>dispatches++},toolSession:{endpoint:'http://127.0.0.1:12345/s/abc123',token,toolNames:['read_messages']}});
  assert.equal(result.markdown,'synthetic answer');f.session.receipt=result.conversationReceipt;
 }
 assert.equal(dispatches,2);const calls=(await readFile(cli.trace,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls.map(x=>x.token),['synthetic-token-1','synthetic-token-2']);
 for(const call of calls){assert.ok(!call.args.includes('--no-session'));assert.ok(!call.args.includes('--continue'));assert.ok(call.args.includes(f.session.file));assert.ok(call.args.includes('--no-builtin-tools'));assert.ok(!JSON.stringify(call.args).includes(call.token));}
 await rm(f.session.file);
 await assert.rejects(executeLocalAgent({id:'pi',prompt:'synthetic prompt',workspace:f.session.workspace,executionSnapshot:{provider:'synthetic',model:'model-a',thinking:'off'},deps:cli.deps,conversationSession:{session:f.session,manifest:f.manifest,beforeDispatch:()=>dispatches++}}));
 assert.equal(dispatches,2);
});

test('prepared header creation is recoverable without overwriting a transcript, and file failures expose no path',async t=>{
 const f=await fixture(t);const recovered=await createPiSession(f.session);assert.equal(recovered.hash,f.receipt.hash);
 await completed(f);await assert.rejects(createPiSession(f.session),error=>error.code==='conversation_session_invalid' && !error.message.includes(f.session.directory));
 await rm(f.session.file);await assert.rejects(validatePiSession(f.session,f.receipt),error=>error.code==='conversation_session_invalid' && !error.message.includes(f.session.directory));
});

test('read-only recovery retains the execution output bound',async t=>{
 const f=await fixture(t);await completed(f);
 const bytes=await readFile(f.session.file,'utf8');await writeFile(f.session.file,bytes.replace('synthetic answer','x'.repeat(2_000_001)));
 assert.equal((await inspectPiTurn(f.session,f.manifest,f.receipt)).state,'unknown');
});
