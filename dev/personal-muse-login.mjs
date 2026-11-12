if (process.env.AGENTROOM_AUTOMATION_VISIBLE !== '1') throw new Error('Login-window acceptance requires explicit AGENTROOM_AUTOMATION_VISIBLE=1 and desktop coordination.');
import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';
// Real public Muse login page acceptance. Does not submit an email/code, import
// browser cookies, send a chat message, or claim successful private-account auth.
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (!process.argv.includes('--real')) throw new Error('Pass --real to load the official Muse login page.');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(join(root,'apps/desktop/package.json'));
const {_electron,expect}=require('@playwright/test');
const parent=process.env.AGENTSTUDIO_DESKTOP_EVIDENCE_DIR||join(root,'output/playwright/muse-login');
await mkdir(parent,{recursive:true});const evidence=await mkdtemp(join(parent,'muse-real-'));
const env={...process.env,AGENTSTUDIO_USER_DATA_DIR:join(evidence,'profile'),AGENTSTUDIO_MOCK_KEYCHAIN:'1',AGENTSTUDIO_CODEX_BIN:join(evidence,'no-model-cli')};
cleanDesktopTestEnv(env);
for(const key of ['ELECTRON_RUN_AS_NODE','AGENTSTUDIO_WORKSPACE','AGENTSTUDIO_PERSONAL_DATA_DIR','AGENTSTUDIO_MUSE_URL','AGENTSTUDIO_CONNECTOR_TRACE','AGENTSTUDIO_CONNECTOR_TRACE_NETWORK'])delete env[key];
const packaged=process.env.AGENTSTUDIO_PACKAGED_APP;
const executablePath=packaged?join(packaged,'Contents/MacOS/AgentRoom'):process.env.AGENTSTUDIO_ELECTRON_BINARY||require('electron');
const checks=[],errors=[];let app,page,flowId;
const verify=(ok,name)=>{if(!ok)throw Error(name);checks.push(name);console.log('PASS '+name)};
try{
 app=await launchDesktopTest(_electron, {executablePath,args:packaged?[]:[join(root,'apps/desktop')],env});
 page=await app.firstWindow();
 await page.getByTestId("im-app").waitFor();

page.on('pageerror',e=>errors.push(e.name));
 await page.getByTestId('im-settings').click();
 await page.getByTestId('personal-service-connect-muse').click();
 await expect.poll(async()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('agentstudio.personal.native-connection-flow')||'null')?.flowId)).toBeTruthy();
 flowId=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('agentstudio.personal.native-connection-flow')).flowId);
 const windows=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({title:w.getTitle(),visible:w.isVisible(),loading:w.webContents.isLoading(),origin:(()=>{try{return new URL(w.webContents.getURL()).origin}catch{return null}})()})));
 await expect.poll(async()=>(await windows()).some(w=>w.title==='Sign in: Muse')).toBe(true);
 const initial=await windows();
 verify(!initial.some(w=>w.title==='Sign in: Muse'&&w.loading&&w.visible),'an unfinished Muse form is not exposed while loading');
 await page.screenshot({path:join(evidence,'loading.png')});
 await expect.poll(async()=>(await windows()).some(w=>w.title==='Sign in: Muse'&&w.visible),{timeout:110000,intervals:[500,1000]}).toBe(true);
 const login=app.windows().find(p=>p!==page&&new URL(p.url()).hostname==='muse.ai');
 verify(Boolean(login),'the ready login window loads the official Muse origin');
 // External service markup has no repository-owned data-testid contract.
 await expect(login.getByRole('button',{name:'Continue',exact:true})).toBeEnabled({timeout:10000});
 verify(true,'the actual Muse Continue action is enabled when the window is shown');
 await login.screenshot({path:join(evidence,'ready-login.png')});
 const reply=await page.evaluate(id=>window.agentStudioPersonal.nativeIntegration({kind:'cancel',flowId:id}),flowId);
 verify(reply.state==='cancelled','cancelling the real login is acknowledged');
 await expect.poll(async()=>(await windows()).filter(w=>w.title==='Sign in: Muse').length).toBe(0);
 verify(true,'cancelling closes only the owned login window');
 const bootstrap=await page.evaluate(async()=>{const r=await window.agentStudioPersonal.request({path:'/api/bootstrap',method:'GET'});return r.body;});
 verify(bootstrap.connections.length===0&&bootstrap.threads.filter(thread=>thread.id!==bootstrap.workspace?.guide?.threadId).length===0,'opening and cancelling login creates no connection, task or imported history');
 verify(errors.length===0,'the personal renderer has no exceptions');
 await writeFile(join(evidence,'results.json'),JSON.stringify({checks,errors,initial,scope:'official public login page only; no email/code submitted or account authenticated'},null,2));
 console.log(JSON.stringify({evidence,checks:checks.length,passed:true}));
}catch(e){await page?.screenshot({path:join(evidence,'failure.png')}).catch(()=>{});await writeFile(join(evidence,'failure.json'),JSON.stringify({name:e.name,message:e.message,checks,errors},null,2));throw e;}
finally{await app?.close();}
