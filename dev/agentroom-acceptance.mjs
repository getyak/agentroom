import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';
// First-use and profile-reset acceptance, always with isolated synthetic identities.
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createPersonalServer} from '../apps/personal/server/index.mjs';
const require=createRequire(new URL('../apps/desktop/package.json',import.meta.url));
const {chromium,_electron}=createRequire(require.resolve('@playwright/test'))('playwright');
const {expect}=require('@playwright/test');
const native=process.argv.includes('--native');
const packagedApp=process.env.AGENTSTUDIO_PACKAGED_APP ? resolve(process.env.AGENTSTUDIO_PACKAGED_APP) : null;
const parent=process.env.AGENTROOM_EVIDENCE_DIR || resolve('output/playwright/agentroom');await mkdir(parent,{recursive:true});
const output=await mkdtemp(join(parent,native?'native-':'browser-'));
const checks=[],errors=[];let app,browser,server,page;
const env={...process.env,AGENTSTUDIO_USER_DATA_DIR:join(output,'normal-profile'),AGENTSTUDIO_MOCK_KEYCHAIN:'1',AGENTSTUDIO_WORKSPACE:'personal'};
cleanDesktopTestEnv(env);
for(const field of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','AGENTROOM_TEST_MODE','AGENTROOM_USER_DATA_DIR','AGENTROOM_PERSONAL_DATA_DIR','AGENTSTUDIO_PERSONAL_DATA_DIR'])delete env[field];
for(const agent of ['CODEX','CLAUDE','PI','GEMINI','OPENCODE'])env[`AGENTSTUDIO_${agent}_BIN`]='/missing-agentroom-synthetic-'+agent.toLowerCase();
const check=text=>{checks.push(text);console.log('PASS '+text);};
async function request(path,body){
 if(native)return page.evaluate(async({path,body})=>{const r=await window.agentStudioPersonal.request({path:'/api'+path,method:body?'POST':'GET',...(body?{body}:{})});if(r.status>=400)throw Error(JSON.stringify(r.body));return r.body;},{path,body});
 const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(await r.text());return r.json();
}
async function launch(args=packagedApp?[]:[resolve('apps/desktop')]){
 app=await launchDesktopTest(_electron, {executablePath:packagedApp?join(packagedApp,'Contents/MacOS/AgentRoom'):require('electron'),args,env,timeout:30000});page=await app.firstWindow();
 page.on('pageerror',e=>errors.push(e.message));await expect(page.getByTestId('im-app')).toBeVisible();
 await expect.poll(()=>request('/health').then(r=>r.ok)).toBe(true);
}
async function preferences(){await page.getByTestId('im-settings').click();await page.getByTestId('personal-tab-testing').click();}
async function bounce(button){
 const receipt=join(output,'relaunch-'+checks.length+'.json');
 await app.evaluate(async({app,dialog},file)=>{
  const fs=process.getBuiltinModule('fs');
  dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});
  app.relaunch=options=>fs.writeFileSync(file,JSON.stringify(options));
 },receipt);
 const closed=app.waitForEvent('close');
 await page.getByTestId(button).click().catch(error=>{if(!/closed|destroyed/.test(String(error)))throw error;});
 await closed;
 const options=JSON.parse(await readFile(receipt,'utf8'));await launch(options.args);
}
try{
 if(native)await launch();else{
  server=await createPersonalServer({dataDir:join(output,'web-data'),port:0,staticDir:resolve('apps/personal/dist'),codexCommand:'/missing-agentroom-codex',discoverLocalAgents:async()=>({agents:[]})});await server.listen();
  browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{channel:'chrome'}:{})});page=await browser.newPage({viewport:{width:1200,height:850}});page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 }
 await expect(page.getByTestId('workspace-guide')).toBeVisible();expect(await page.title()).toMatch(/^AgentRoom/);
 const initialGuide=(await request('/bootstrap')).workspace.guide;
 await expect(page.getByTestId(`im-chat-${initialGuide.threadId}`).getByTestId('im-avatar')).toHaveAttribute('data-avatar-source','agentroom');
 for(const [button,target] of [['workspace-guide-discover','im-host-discovery'],['workspace-guide-local','im-local-picker'],['workspace-guide-roles','im-onboarding'],['workspace-guide-connect','personal-tab-connections']]){
  await page.getByTestId(button).click();await expect(page.getByTestId(target)).toBeVisible();await page.getByTestId('personal-modal-close').click();
 }
 check('Roo opens first with the AgentRoom icon and all four working setup actions');
 await page.screenshot({path:join(output,'welcome.png')});
 await page.getByTestId('workspace-owner-name').fill('原工作区测试人');await page.getByTestId('workspace-guide-finish').click();await expect(page.getByTestId('workspace-guide-completed')).toBeVisible();

 expect((await request('/contacts')).contacts.find(c=>c.id==='self').name).toBe('原工作区测试人');
 await page.reload();await expect(page.getByTestId('workspace-guide-completed')).toBeVisible();check('Roo saves owner identity and stays completed after reload');
 await request('/memories',{text:'原工作区独有的合成记忆',clientId:crypto.randomUUID()});
 await page.evaluate(()=>localStorage.setItem('agentroom-acceptance-marker','normal-marker'));
 await page.evaluate(()=>{const url=new URL(location.href);url.searchParams.set('artifact','synthetic-old-artifact');url.searchParams.set('revision','synthetic-old-revision');history.replaceState(null,'',url);});
 await preferences();await page.getByTestId('workspace-reopen-welcome').click();await expect(page.getByTestId('workspace-guide')).toBeVisible();
 await expect.poll(()=>new URL(page.url()).searchParams.has('artifact')).toBe(false);await expect.poll(()=>new URL(page.url()).searchParams.has('revision')).toBe(false);
 expect((await request('/bootstrap')).memories).toHaveLength(1);check('reopening onboarding preserves existing workspace data');
 await page.getByTestId('workspace-guide-finish').click();
 if(native){
  await app.evaluate(async({session})=>session.defaultSession.cookies.set({url:'https://agentroom.invalid',name:'synthetic-profile',value:'normal-cookie',expirationDate:Math.floor(Date.now()/1000)+86400}).then(()=>session.defaultSession.cookies.flushStore()));
  expect(await page.evaluate(()=>window.agentStudioPersonal.testMode)).toBe(false);
  expect(await page.evaluate(()=>window.agentStudioPersonal.testWorkspace('unsupported').then(()=>false,()=>true))).toBe(true);
  await preferences();await bounce('workspace-enter-test');
  await expect(page.getByTestId('workspace-mode')).toHaveAttribute('data-test-mode','true');
  await page.getByTestId('im-focus-toggle').click();await expect(page.getByTestId('im-list-panel')).toBeHidden();await expect(page.getByTestId('workspace-mode')).toBeVisible();await page.getByTestId('im-focus-toggle').click();
  await page.evaluate(()=>window.dispatchEvent(new Event('offline')));await expect(page.getByTestId('workspace-mode')).toBeVisible();await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('workspace-guide')).toBeVisible();
  expect((await request('/bootstrap')).memories).toHaveLength(0);expect(await page.evaluate(()=>localStorage.getItem('agentroom-acceptance-marker'))).toBeNull();
  expect(await app.evaluate(async({session})=>(await session.defaultSession.cookies.get({name:'synthetic-profile'})).length)).toBe(0);check('entering test mode separates data, localStorage and cookies from the original profile');
  await request('/memories',{text:'本轮测试独有的合成记忆',clientId:crypto.randomUUID()});
  await page.evaluate(()=>localStorage.setItem('agentroom-acceptance-marker','test-marker'));
  await page.getByTestId('workspace-guide-finish').click();
  await preferences();await page.screenshot({path:join(output,'test-controls.png')});await bounce('workspace-reset-test');
  await expect(page.getByTestId('workspace-guide')).toBeVisible();expect((await request('/bootstrap')).memories).toHaveLength(0);expect(await page.evaluate(()=>localStorage.getItem('agentroom-acceptance-marker'))).toBeNull();check('reset creates a fresh test identity and returns to onboarding');
  await preferences();await bounce('workspace-leave-test');
  await expect(page.getByTestId('workspace-mode')).toHaveAttribute('data-test-mode','false');
  expect((await request('/bootstrap')).memories[0].text).toBe('原工作区独有的合成记忆');expect((await request('/bootstrap')).workspace.displayName).toBe('原工作区测试人');
  expect(await page.evaluate(()=>localStorage.getItem('agentroom-acceptance-marker'))).toBe('normal-marker');
  expect(await app.evaluate(async({session})=>(await session.defaultSession.cookies.get({name:'synthetic-profile'}))[0]?.value)).toBe('normal-cookie');check('returning restores the original name, memory, localStorage and cookies');
 }else{
  await preferences();await expect(page.getByTestId('workspace-enter-test')).toHaveCount(0);await page.getByTestId('workspace-reopen-welcome').click();
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'dark'});await expect(page.getByTestId('workspace-guide')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:join(output,'welcome-narrow-dark.png')});check('browser keeps native reset unavailable and shows readable narrow onboarding');
 }
 expect(errors).toEqual([]);
}finally{
 await writeFile(join(output,'receipt.json'),JSON.stringify({native,checks,errors,syntheticOnly:true,output},null,2));
 await app?.close();await browser?.close();await server?.close();console.log(JSON.stringify({output,checks,errors}));
}
