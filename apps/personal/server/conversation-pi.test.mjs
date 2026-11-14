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
 const {mkdir}=await import('node:fs/promises');const dir=join(f.session.directory,'.pi/agent');await mkdir(dir,{recursive:true});await writeFile(join(dir,'models.json'),JSON.stringify({apiKey:'!synthetic-command'}));
 assert.equal(await piBindingFingerprint({home:f.session.directory,env:{}}),null);
});

import { spawn } from 'node:child_process';
import { executeLocalAgent, conversationPiCapability } from './local-agents.mjs';
const CLI=String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),args=process.argv.slice(2);
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
if(args.includes('--version'))process.stdout.write('0.85.1');
else if(args.includes('--help'))process.stdout.write('--no-builtin-tools');
else if(args.includes('rpc'))process.stdin.on('data',b=>{const c=JSON.parse(b);out({id:c.id,success:true,data:{models:[{provider:'synthetic',id:'model-a',reasoning:false}]}});});
else {let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
 const p=args[args.indexOf('--session')+1],rows=fs.readFileSync(p,'utf8').trim().split('\n').map(JSON.parse);let parent=rows.at(-1).id;
 if(rows.length===1)parent=null;
 const add=row=>{row.id=crypto.randomUUID();row.parentId=parent;parent=row.id;rows.push(row);fs.appendFileSync(p,JSON.stringify(row)+'\n');return row.id;};
 const data={schema:1,runId:process.env.AGENTROOM_CONVERSATION_RUN,payloadHash:process.env.AGENTROOM_CONVERSATION_HASH};
 const s=add({type:'custom',customType:'agentroom_turn_started',data}),u=add({type:'message',message:{role:'user',content:input}});
 const m={role:'assistant',provider:'synthetic',model:'model-a',stopReason:'stop',content:[{type:'text',text:'synthetic answer'}]},a=add({type:'message',message:m});
 add({type:'custom',customType:'agentroom_turn_completed',data:{...data,sessionId:rows[0].id,startedEntryId:s,userEntryId:u,assistantEntryId:a,provider:'synthetic',model:'model-a'}});
 fs.appendFileSync(process.env.SYNTHETIC_TRACE,JSON.stringify({args,input,token:process.env.AGENTROOM_TOOL_TOKEN})+'\n');
 out({type:'message_end',message:m});out({type:'agent_settled'});
 });}
`;
export async function syntheticPi(t) {
 const {mkdir}=await import('node:fs/promises');const directory=await mkdtemp(join(tmpdir(),'agentroom-pi-cli-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const command=join(directory,'pi');await writeFile(command,CLI,{mode:0o700});const trace=join(directory,'trace');
 const deps={home:directory,commands:{pi:command},env:{PATH:process.env.PATH,SYNTHETIC_TRACE:trace},spawn:(cmd,args,opts)=>spawn(process.execPath,[cmd,...args],opts)};
 await mkdir(join(directory,'work'));return {directory,trace,deps};
}
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
