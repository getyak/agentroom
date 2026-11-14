// Isolated two-turn acceptance. The default uses an owned synthetic CLI.
// AGENTROOM_LIVE_PI=1 explicitly enables the existing Pi provider with synthetic data only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {EventEmitter} from 'node:events';
import {createPersonalServer} from '../apps/personal/server/index.mjs';
import {discoverLocalAgents} from '../apps/personal/server/local-agents.mjs';
import {syntheticPi} from './fixtures/conversation-pi.mjs';
const live=process.env.AGENTROOM_LIVE_PI==='1';
if(!process.env.AGENTROOM_CONTEXT_EVIDENCE_DIR)throw new Error('Set AGENTROOM_CONTEXT_EVIDENCE_DIR to an owned artifact directory');
const output=resolve(process.env.AGENTROOM_CONTEXT_EVIDENCE_DIR);await mkdir(output,{recursive:true});
const cleanup=[],events=new EventEmitter();let app,browser;const errors=[];
try {
 const cli=live?null:await syntheticPi({after:fn=>cleanup.push(fn)});
 const profile=live?(await discoverLocalAgents({deps:{commands:Object.fromEntries(['codex','claude','gemini','opencode'].map(id=>[id,'/missing-context-acceptance-cli']))}})).agents.find(a=>a.id==='pi').profile:{agentId:'pi',defaults:{provider:'synthetic',model:'model-a',thinking:'off'},models:[{provider:'synthetic',id:'model-a',reasoning:false,thinkingLevels:['off']}],providers:['synthetic'],thinkingLevels:['off'],version:'synthetic-v1'};
 app=await createPersonalServer({dataDir:join(output,'data'),port:0,assistantManager:false,staticDir:resolve('apps/personal/dist'),...(cli?{localAgentDeps:cli.deps}:{}),
  discoverLocalAgents:async()=>({checkedAt:new Date().toISOString(),agents:[{id:'pi',name:'Pi',installed:true,auth:{status:'configured'},execution:{supported:true},profile}]}),onChange:()=>events.emit('change')});await app.listen();
 app.store.put('setting',{id:'workspace-onboarding',completed:true});
 let sequence=0;
 const api=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${app.address().port}/api${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify({...body,clientId:`context-acceptance-${++sequence}`}):undefined});const result=await r.json();assert.ok(r.ok,JSON.stringify(result));return result;};
 const wait=(id,n)=>new Promise((resolveWait,reject)=>{const check=()=>{const thread=app.store.get('thread',id);if(thread.runs.length===n && ['completed','blocked','unknown'].includes(thread.runs.at(-1).status)){clearTimeout(timer);events.off('change',check);resolveWait(thread);}};const timer=setTimeout(()=>{events.off('change',check);reject(new Error('Acceptance turn timed out'));},120000);events.on('change',check);check();});
 await api('/contacts');const contact=await api('/contacts',{kind:'agent',name:'会话验收伙伴',handle:'context_acceptance',instructions:'Reply briefly and remember the supplied synthetic word. Use no tools unless explicitly asked.',binding:{type:'local',localAgentId:'pi'}});
 const chat=await api('/chats',{kind:'direct',memberIds:[contact.id]});
 const prompts=['Remember synthetic word AZURE_837. Reply only OK.','What synthetic word did I give you? Reply only that word.'];
 const rounds=[];
 for(const [i,text] of prompts.entries()) {
  await api(`/threads/${chat.id}/messages`,{text,...(i===0?{attachments:[{name:'synthetic-context.txt',text:'Synthetic source text. '.repeat(500)}]}:{})});const thread=await wait(chat.id,i+1),run=thread.runs.at(-1);
  assert.equal(run.status,'completed',run.error);assert.equal(run.contextDispatch.mode,i?'delta':'bootstrap');
  if(live && i===1)assert.ok(thread.messages.at(-1).text.includes('AZURE_837'));
  rounds.push({round:i+1,...run.contextDispatch});
 }
 assert.equal(rounds[1].messageCount,1);assert.equal(rounds[1].retainedMessageCount,2);assert.ok(rounds[1].bytes<rounds[0].bytes);
 const require=createRequire(new URL('../apps/desktop/package.json',import.meta.url)),{chromium,expect}=require('@playwright/test');
 browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{channel:'chrome'}:{})});const page=await browser.newPage({viewport:{width:1320,height:860}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${app.address().port}/?thread=${chat.id}`);await expect(page.getByTestId('im-message-input')).toBeVisible();await page.getByTestId('im-results').click();await expect(page.getByTestId('im-execution-record')).toHaveCount(2);
 await page.getByTestId('im-execution-toggle').nth(1).click();await expect(page.getByTestId('im-context-dispatch').nth(1)).toContainText('增量上下文');await expect(page.getByTestId('im-context-dispatch').nth(1)).toContainText('沿用 2 条');await expect(page.getByTestId('im-context-dispatch').nth(1)).toContainText('完成回执与回复已保存');
 await page.screenshot({path:join(output,'incremental-context.png')});assert.deepEqual(errors,[]);
 const evidence={mode:live?'live-pi':'synthetic',provider:profile.defaults.provider,model:profile.defaults.model,rounds,agentroomPromptReduction:1-rounds[1].bytes/rounds[0].bytes,providerTokens:'not measured',checks:['separate child per turn','exact receipt saved','only new message sent','old attachment not retransmitted','browser diagnostics visible','no page errors']};
 await writeFile(join(output,'report.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{await browser?.close();await app?.close();for(const fn of cleanup.reverse())await fn();}
