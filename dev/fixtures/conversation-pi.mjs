import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const CLI=String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),args=process.argv.slice(2);
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
if(args.includes('--version'))process.stdout.write('0.85.1');
else if(args.includes('--help'))process.stdout.write('--session --session-dir --no-builtin-tools --no-extensions');
else if(args.includes('rpc'))process.stdin.on('data',b=>{const c=JSON.parse(b);out({id:c.id,success:true,data:{models:[{provider:'synthetic',id:'model-a',reasoning:false}]}});});
else {let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
 fs.appendFileSync(process.env.SYNTHETIC_TRACE,JSON.stringify({args,input,token:process.env.AGENTROOM_TOOL_TOKEN})+'\n');

 let context;try{context=JSON.parse(input.split('<untrusted_thread_context>\n')[1].split('\n</untrusted_thread_context>')[0]);}catch{}
 const request=context?.messages.find(m=>m.id===context.currentMessageId)?.text || input;
 const p=args[args.indexOf('--session')+1],rows=fs.readFileSync(p,'utf8').trim().split('\n').map(JSON.parse);let parent=rows.at(-1).id;
 if(rows.length===1)parent=null;
 const add=row=>{row.id=crypto.randomUUID();row.parentId=parent;parent=row.id;rows.push(row);fs.appendFileSync(p,JSON.stringify(row)+'\n');return row.id;};
 const data={schema:1,runId:process.env.AGENTROOM_CONVERSATION_RUN,payloadHash:process.env.AGENTROOM_CONVERSATION_HASH};
 const s=add({type:'custom',customType:'agentroom_turn_started',data}),u=add({type:'message',message:{role:'user',content:input}});
 if(process.env.SYNTHETIC_HANG==='1'){out({type:'message_start',message:{role:'assistant'}});setInterval(()=>{},1000);return;}
 const m={role:'assistant',provider:'synthetic',model:'model-a',stopReason:'stop',content:[{type:'text',text:request.includes('[SILENCE]')?JSON.stringify({action:'silence',reason:'synthetic silent turn'}):context?.conversation?.kind==='group'?JSON.stringify({action:'reply',text:'synthetic answer'}):'synthetic answer'}]},a=add({type:'message',message:m});
 add({type:'custom',customType:'agentroom_turn_completed',data:{...data,sessionId:rows[0].id,startedEntryId:s,userEntryId:u,assistantEntryId:a,provider:'synthetic',model:'model-a'}});
 out({type:'message_end',message:m});out({type:'agent_settled'});
 });}
`;
export async function syntheticPi(t) {
 const {mkdir}=await import('node:fs/promises');const directory=await mkdtemp(join(tmpdir(),'agentroom-pi-cli-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const command=join(directory,'pi');await writeFile(command,CLI,{mode:0o700});const trace=join(directory,'trace');
 const deps={home:directory,commands:{pi:command},env:{PATH:process.env.PATH,SYNTHETIC_TRACE:trace},spawn:(cmd,args,opts)=>spawn(process.execPath,[cmd,...args],opts)};
 await mkdir(join(directory,'work'));return {directory,trace,deps};
}
