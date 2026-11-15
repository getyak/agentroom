import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';

if(!process.env.ROOMIE_EVIDENCE_DIR)throw new Error('Set ROOMIE_EVIDENCE_DIR to a managed artifact directory');
const real=process.argv.includes('--real'),parent=resolve(process.env.ROOMIE_EVIDENCE_DIR);await mkdir(parent,{recursive:true});
const output=await mkdtemp(join(parent,real?'context-real-':'context-browser-'));
const require=createRequire(new URL('../apps/desktop/package.json',import.meta.url));
const {chromium,expect}=require('@playwright/test');
const profile={agentId:'pi',defaults:{provider:'fixture',model:'fixture-model',thinking:'low'},providers:['fixture'],models:[{provider:'fixture',id:'fixture-model',thinkingLevels:['low']}],thinkingLevels:['low'],version:'fixture-v1'};
const detected={agents:[{id:'pi',name:'Pi',installed:true,auth:{status:'configured'},execution:{supported:true},profile}]};
const calls=[];
async function call(request,name,args={}) {
 const response=await fetch(request.toolSession.endpoint,{method:'POST',headers:{authorization:`Bearer ${request.toolSession.token}`,'content-type':'application/json'},body:JSON.stringify({name,arguments:args,callId:crypto.randomUUID()})});
 assert.equal(response.status,200);calls.push(name);return (await response.json()).result;
}
const execute=async request=>{
 if(request.prompt.includes('challenge:'))return {markdown:JSON.stringify({status:'ok',challenge:request.prompt.match(/challenge: ([\w-]+)/)[1]})};
 const groups=await call(request,'roomie_groups'),group=groups.rooms.find(r=>r.canReadMessages),read=await call(request,'roomie_read_group',{roomId:group.id});await call(request,'roomie_environment');
 return {markdown:JSON.stringify({reply:'发布前先补上 Safari 兼容性核对，核对通过后再决定发布。',sources:[{roomId:group.id,messageId:read.messages[0].id}]})};
};
let browser;const errors=[];
const server=await createPersonalServer({dataDir:join(output,'data'),port:0,staticDir:resolve('apps/personal/dist'),roomieTickMs:250,...(!real?{discoverLocalAgents:async()=>detected,executeLocalAgent:execute,roomieBindingIdentity:async()=>'synthetic'}:{})});
const api=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify({...body,clientId:crypto.randomUUID()})}:{})});assert.ok(r.ok,await r.clone().text());return r.json();};
try {
 await server.listen();const initial=await api('/roomie'),guideId=initial.contact.id;
 if(real)assert.ok(initial.agents.find(a=>a.id===initial.settings.agentId)?.planningSupported,'Selected guide must support isolated planning');
 const peer=await api('/contacts',{kind:'human',name:'合成验收成员',handle:'context-fixture'});
 const group=await api('/chats',{kind:'group',title:'合成发布协调',memberIds:[guideId,peer.id]});
 const sourceId=crypto.randomUUID();server.store.updateThread(group.id,t=>{t.messages.push({id:sourceId,role:'user',contactId:'self',recipientIds:[...t.memberIds],text:'合成验收项目：发布前必须验证 Safari。目前 Chrome 检查已通过，Safari 兼容性尚未核对。需要明确一个最有价值的下一步。',createdAt:new Date().toISOString()});});
 browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{channel:'chrome'}:{})});const page=await browser.newPage({viewport:{width:1220,height:860}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByTestId('roomie-open').click();await page.getByTestId('roomie-resources').locator('summary').click();
 await expect(page.getByTestId('roomie-proactive')).not.toBeChecked();const ownerMessages=initial.messages.filter(m=>m.role==='user').length;
 await page.getByTestId('roomie-proactive').check();await expect(page.getByTestId('roomie-proactive')).toBeChecked();
 let state;await expect.poll(async()=>{state=await api('/roomie');return state.observation?.status;},{timeout:real?300000:15000}).toMatch(/completed|failed|interrupted/);
 assert.equal(state.observation.status,'completed',state.observation.error);
 const message=state.messages.find(m=>m.roomieObservation?.sources.some(s=>s.roomId===group.id&&s.messageId===sourceId));assert.ok(message,'Advice must reference the actual synthetic group message');
 assert.equal(state.messages.filter(m=>m.role==='user').length,ownerMessages);
 await expect(page.getByTestId('roomie-advice-sources')).toBeVisible();await page.getByTestId('roomie-advice-sources').locator('summary').click();await expect(page.getByTestId('roomie-advice-source')).toContainText('合成发布协调');
 await page.screenshot({path:join(output,'advice-with-source.png')});await page.getByTestId('roomie-proactive').uncheck();assert.equal((await api('/roomie')).settings.proactive,false);
 assert.equal(errors.length,0);await writeFile(join(output,'receipt.json'),JSON.stringify({real,backend:initial.settings.agentId,executionSnapshot:server.store.require('roomie_job',state.observation.id).executionSnapshot,jobId:state.observation.id,status:state.observation.status,modelAdvice:message.text,sources:message.roomieObservation,calls,errors},null,2));
 console.log(JSON.stringify({output,real,status:state.observation.status,sources:message.roomieObservation.sources.length,errors}));
} finally {await browser?.close();await server.close();}
