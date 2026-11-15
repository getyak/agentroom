// Unified Roo chat acceptance. --real uses existing CLI login in isolated app data.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPersonalServer } from '../apps/personal/server/index.mjs';
import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium, _electron, expect } = require('@playwright/test');
const real=process.argv.includes('--real'),native=process.argv.includes('--native');
const parent=resolve(process.env.ROOMIE_EVIDENCE_DIR || 'output/playwright/roomie');await mkdir(parent,{recursive:true});
const output=await mkdtemp(join(parent,`${native?'native':'browser'}-roo-${real?'real':'fixture'}-`));
const marker=`ROO_${randomUUID().replaceAll('-','').slice(0,12)}`;
const profile={agentId:'codex',defaults:{provider:'fixture',model:'fixture-model',thinking:'low'},providers:['fixture'],models:[],thinkingLevels:['low'],version:'v1'};
let server,browser,app,page;const errors=[],checks=[];let threadId;
const api=async(path,body)=>{
 if(native)return page.evaluate(async({path,body})=>{const r=await window.agentStudioPersonal.request({path:'/api'+path,method:body?'POST':'GET',...(body?{body}:{})});if(r.status>=400)throw Error(JSON.stringify(r.body));return r.body;},{path,body});
 const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(await r.text());return r.json();
};
const check=name=>{checks.push(name);console.log('PASS '+name);};
try {
 if(native){
  if(!real)throw Error('Native unified chat acceptance requires --real; synthetic UI runs in the browser');
  const env={...process.env,AGENTSTUDIO_USER_DATA_DIR:join(output,'profile'),AGENTSTUDIO_MOCK_KEYCHAIN:'1',AGENTSTUDIO_WORKSPACE:'personal'};cleanDesktopTestEnv(env);
  const packaged=process.env.AGENTSTUDIO_PACKAGED_APP;
  app=await launchDesktopTest(_electron,{executablePath:packaged?join(packaged,'Contents/MacOS/AgentRoom'):require('electron'),args:packaged?[]:[resolve('apps/desktop')],env,timeout:45000});
  page=await app.firstWindow();
 }else{
  server=await createPersonalServer({port:0,dataDir:join(output,'data'),staticDir:resolve('apps/personal/dist'),...(!real?{discoverLocalAgents:async()=>({agents:[{id:'codex',name:'Codex',installed:true,auth:{status:'configured'},execution:{supported:true},profile}]}),executeLocalAgent:async request=>({markdown:request.prompt.includes('只回复那个记号')?marker:'你好，我是阿屋。'})}:{})});
  await server.listen();browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{channel:'chrome'}:{})});page=await browser.newPage({viewport:{width:1280,height:900}});await page.goto(`http://127.0.0.1:${server.address().port}`);
 }
 page.on('pageerror',error=>errors.push(error.message));
 await page.getByTestId('roomie-open').click();await expect(page.getByTestId('roomie-chat')).toBeVisible({timeout:30000});
 threadId=(await api('/roomie')).threadId;
 await expect(page.getByTestId('im-message-input')).toHaveCount(1);await expect(page.getByTestId('roomie-input')).toHaveCount(0);
 const state=await api('/roomie');expect(state.settings.agentId).toBeTruthy();expect((await api('/threads/'+threadId)).runs).toHaveLength(0);check('sidebar and setup use one automatically bound Roo conversation with one composer and no model call on opening');
 // The removed setup composer retains its unsent draft through migration.
 await page.evaluate(()=>localStorage.setItem('agentroom.roomie.draft','旧配置草稿'));await page.getByTestId('roomie-open').click();await expect(page.getByTestId('im-message-input')).toHaveValue('旧配置草稿');check('legacy setup draft transfers into the ordinary chat composer');
 const send=async(text,count)=>{await page.getByTestId('im-message-input').fill(text);await page.getByTestId('im-send').click();let thread;await expect.poll(async()=>{thread=await api('/threads/'+threadId);const last=thread.runs.at(-1);if(last?.status==='failed'||last?.status==='unknown')throw Error(last.error||last.status);return thread.runs.length===count&&last?.status==='completed';},{timeout:real?300000:15000}).toBe(true);return thread;};
 await send(`你好，我是验收访客。本轮记号是 ${marker}。请用一句话打招呼并记住记号，不调用工具。`,1);
 const result=await send('我刚才给你的本轮记号是什么？只回复那个记号，不调用工具。',2);
 expect(result.messages.at(-1).text).toContain(marker);expect((await api('/roomie')).job).toBe(null);check('two CLI turns retain conversational context without starting role recommendation jobs');
 await page.reload();await page.getByTestId('roomie-open').click();expect((await api('/roomie')).threadId).toBe(threadId);expect((await api('/threads/'+threadId)).runs).toHaveLength(2);check('reopening setup and reloading retain the same messages and execution history');
 if(!real){
  await page.getByTestId('roomie-model-options').click();await page.getByTestId('im-model-options-toggle').click();await page.getByTestId('im-model-policy').selectOption('fixed');await page.getByTestId('im-model-name').fill('unsaved-model');await page.getByTestId('roomie-refresh').click();await expect(page.getByTestId('im-model-name')).toHaveValue('unsaved-model');
  let releaseOld,oldArrived;const oldGate=new Promise(resolve=>{releaseOld=resolve;});const oldSeen=new Promise(resolve=>{oldArrived=resolve;});await page.route('**/api/roomie',async route=>{const response=await route.fetch();oldArrived();await oldGate;await route.fulfill({response});});await page.getByTestId('roomie-refresh').click();await oldSeen;
  let releaseSave,saveArrived;const gate=new Promise(resolve=>{releaseSave=resolve;});const arrived=new Promise(resolve=>{saveArrived=resolve;});
  await page.route('**/api/roomie/actions',async route=>{saveArrived();await gate;await route.continue();});await page.getByTestId('roomie-save-backend').click();await arrived;await expect(page.getByTestId('im-model-name')).toBeDisabled();releaseSave();await expect.poll(()=>api('/roomie').then(s=>s.contact.execution.model)).toBe('unsaved-model');releaseOld();await expect(page.getByTestId('im-model-name')).toBeEnabled();await expect(page.getByTestId('im-model-name')).toHaveValue('unsaved-model');await page.unrouteAll({behavior:'wait'});check('refresh preserves unsaved model settings and an in-flight save prevents newer edits being overwritten');
  const {Messenger}=await import('../apps/personal/server/messenger.mjs');server.store.put('contact',{id:'historical-roo',kind:'agent',systemRole:'guide',name:'历史阿屋',handle:'historical-roo',binding:{type:'local',localAgentId:'codex'},configuration:{modelMode:'follow',thinking:'follow'},version:1});
  const history=new Messenger(server.store).createChat({kind:'direct',memberIds:['historical-roo']});
  await page.goto(`http://127.0.0.1:${server.address().port}/?thread=${history.id}`);await expect(page.getByTestId('roo-open-canonical')).toBeVisible();await expect(page.getByTestId('roomie-chat')).toHaveCount(0);await page.getByTestId('roo-open-canonical').click();await expect(page.getByTestId('roomie-chat')).toBeVisible();expect(new URL(page.url()).searchParams.get('thread')).toBe(threadId);check('historical Roo identities keep their conversations and route configuration to the canonical Roo thread');
 }
 await page.getByTestId('roo-settings').locator('summary').first().click();await page.screenshot({path:join(output,'roo-chat.png')});
 expect(errors).toEqual([]);await writeFile(join(output,'runtime.json'),JSON.stringify(await api('/health'),null,2));
 await writeFile(join(output,'conversation.json'),JSON.stringify({backend:state.settings.agentId,threadId,runs:result.runs.map(r=>({id:r.id,localAgentId:r.localAgentId,status:r.status,model:r.executionSnapshot?.model})),messages:result.messages.map(m=>({role:m.role,text:m.text}))},null,2));
}finally{await writeFile(join(output,'receipt.json'),JSON.stringify({real,native,threadId,checks,errors},null,2));await app?.close();await browser?.close();await server?.close();console.log(JSON.stringify({output,checks,errors}));}
