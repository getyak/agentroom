import { seedLegacyAgentContacts } from "./legacy-agent-fixture.mjs";
// Isolated automatic member-portrait journey. No real account, model, conversation or image is used.
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPersonalServer} from '../apps/personal/server/index.mjs';
import {cleanDesktopTestEnv, launchDesktopTest} from './desktop-test-env.mjs';

const require=createRequire(new URL('../apps/desktop/package.json',import.meta.url));
const {chromium,_electron}=createRequire(require.resolve('@playwright/test'))('playwright');
const {expect}=require('@playwright/test');
const native=process.argv.includes('--native');
const parent=process.env.AGENTROOM_EVIDENCE_DIR||resolve('output/playwright/group-avatars');
await mkdir(parent,{recursive:true});
const output=await mkdtemp(join(parent,native?'native-':'browser-'));
const checks=[],errors=[],consoleMessages=[];
let server,browser,application,page;
const env={...process.env,AGENTSTUDIO_USER_DATA_DIR:join(output,'profile'),AGENTSTUDIO_MOCK_KEYCHAIN:'1',AGENTSTUDIO_WORKSPACE:'personal'};
cleanDesktopTestEnv(env);
for(const agent of ['CODEX','CLAUDE','PI','GEMINI','OPENCODE'])env[`AGENTSTUDIO_${agent}_BIN`]=join(output,'missing-'+agent);
const watchPage=target=>{
 target.on('pageerror',e=>errors.push(e.message));
 target.on('console',message=>{
  if(!['warning','error'].includes(message.type()))return;
  const text=message.text().replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g,'[synthetic image]').slice(0,500);
  consoleMessages.push({type:message.type(),text});
  if(message.type()==='error')errors.push(text);
 });
};
const launchNative=async()=>{
 const packaged=process.env.AGENTSTUDIO_PACKAGED_APP;
 application=await launchDesktopTest(_electron, {executablePath:packaged?join(packaged,'Contents/MacOS/AgentRoom'):require('electron'),args:packaged?[]:[resolve('apps/desktop')],env,timeout:60000});
 expect(await application.evaluate(({app})=>app.getPath('userData'))).toBe(join(output,'profile'));
 page=await application.firstWindow();
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1120,height:900}));
 watchPage(page);
 await expect(page.getByTestId('im-app')).toBeVisible();
};
const request=async(path,body)=>{
 if(native)return page.evaluate(async({path,body})=>{
  const r=await window.agentStudioPersonal.request({path:'/api'+path,method:body?'POST':'GET',...(body?{body}:{})});
  if(r.status>=400)throw new Error(`HTTP ${r.status}`);return r.body;
 },{path,body});
 const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
 if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();
};
const check=name=>{checks.push(name);console.log('PASS '+name);};
const capture=name=>page.screenshot({path:join(output,name+'.png')});
const preview=()=>page.getByTestId('im-group-avatar-preview').getByTestId('im-avatar');
const editor=()=>page.getByTestId('im-chat-info').click();
const save=async()=>{await expect(page.getByTestId('im-group-save')).toBeEnabled();await page.getByTestId('im-group-save').click();await expect(page.getByTestId('im-group-editor')).toHaveCount(0);};

seedLegacyAgentContacts(native ? join(output,"profile","personal") : join(output,"data"));
try{
 if(native)await launchNative();else{
  server=await createPersonalServer({dataDir:join(output,'data'),port:0,staticDir:resolve('apps/personal/dist'),codexCommand:'/missing-group-avatar-agent',discoverLocalAgents:async()=>({agents:[]})});await server.listen();
  browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{channel:'chrome'}:{})});
  page=await browser.newPage({viewport:{width:1120,height:900}});watchPage(page);await page.goto(`http://127.0.0.1:${server.address().port}`);
 }
 expect(await page.title()).toMatch(/^AgentRoom/);
 await expect(page.getByTestId('im-app')).toBeVisible();
 await request('/workspace/onboarding',{action:'complete',name:'图标验收',clientId:randomUUID()});
 const people=[];
 for(let i=0;i<10;i++)people.push(await request('/contacts',{kind:'agent',name:`拼图伙伴${i+1}`,handle:`mosaic-${i}`,binding:{type:'local',localAgentId:'codex'},avatar:{version:1,style:'bottts',seed:`mosaic-${i}`,palette:['blue','orange','teal','violet','rose'][i%5],eyes:'happy',mouth:'smile02',top:'radar',motion:true},clientId:randomUUID()}));
 await page.getByTestId('im-refresh').click();
 await page.getByTestId('im-new').click();await page.getByTestId('im-new-group').click();
 await expect(page.getByTestId('im-group-avatar-file')).toHaveCount(0);
 await expect(page.getByTestId('im-group-motif-coffee')).toHaveCount(0);
 await expect(page.getByTestId('im-group-avatar-reset')).toHaveCount(0);
 for(const checkbox of await page.getByTestId('im-group-editor').getByTestId(/^im-member-/).all())await checkbox.uncheck();
 await page.getByTestId('im-group-name').fill('自动成员拼图');
 for(const person of people.slice(0,2))await page.getByTestId('im-member-'+person.id).check();
 await expect(preview()).toHaveAttribute('data-group-avatar-kind','members');
 await expect(preview()).toHaveAttribute('data-member-count','3');
 await expect(preview().getByTestId('im-group-member-avatar')).toHaveCount(3);
 await capture('three-member-preview');await save();
 const id=new URL(page.url()).searchParams.get('thread');expect(id).toBeTruthy();
 const row=()=>page.getByTestId('im-chat-'+id);
 await row().hover();await page.getByTestId('im-pin-'+id).click();
 const surfaces=()=>[page.getByTestId('im-chat-info').getByTestId('im-avatar'),row().getByTestId('im-avatar'),page.getByTestId('im-pinned-'+id).getByTestId('im-avatar')];
 const assertMembers=async count=>{for(const avatar of surfaces()){await expect(avatar).toHaveAttribute('data-group-avatar-kind',count<3?'peer':'members');await expect(avatar).toHaveAttribute('data-member-count',String(count));}};
 await assertMembers(3);
 for(const avatar of surfaces()){
  await expect(avatar.getByTestId('im-avatar-image')).toHaveCount(2);
  await expect(avatar.getByTestId('im-presence-dot')).toHaveCount(0);
  for(const tile of await avatar.getByTestId('im-group-member-avatar').all()){await expect(tile).toHaveAttribute('data-activity','idle');await expect(tile).toHaveAttribute('data-motion','off');}
 }
 expect(await page.getByTestId('im-pinned-'+id).getByTestId('im-avatar').evaluate(e=>getComputedStyle(e).borderRadius)).toBe('50%');
 check('groups automatically compose member portraits on every conversation surface');
 const cells=await surfaces()[0].getByTestId('im-group-member-avatar').evaluateAll(elements=>elements.map(e=>({id:e.dataset.memberId,html:e.innerHTML})));
 expect(cells.map(x=>x.id)).toContain('self');
 await expect(page.getByTestId('im-group-avatar-collage').first()).toBeVisible();
 await editor();await page.getByTestId('im-member-'+people[2].id).check();
 await expect(preview()).toHaveAttribute('data-member-count','4');await capture('four-member-preview');await save();await assertMembers(4);
 await editor();for(const person of people.slice(3))await page.getByTestId('im-member-'+person.id).check();
 await expect(preview()).toHaveAttribute('data-member-count','9');await save();await assertMembers(9);await capture('nine-member-group');
 check('member edits update the preview and saved portraits, capped at nine tiles');
 let thread=await request('/threads/'+id);
 const legacy={kind:'preset',icon:'coffee',color:'violet'};
 await request('/chats/'+id,{version:thread.version,groupAvatar:legacy,clientId:randomUUID()});
 await page.getByTestId('im-refresh').click();await assertMembers(9);
 await editor();await page.getByTestId('im-group-name').fill('自动成员拼图已改名');await save();
 expect((await request('/threads/'+id)).groupAvatar).toEqual(legacy);
 await page.reload();await assertMembers(9);
 check('legacy custom metadata cannot override the mosaic and is preserved by ordinary edits');
 thread=await request('/threads/'+id);
 await request('/chats/'+id,{version:thread.version,memberIds:['self',people[0].id,people[1].id],clientId:randomUUID()});
 await page.getByTestId('im-refresh').click();await assertMembers(3);
 const portrait=avatar=>avatar.getByTestId('im-group-member-avatar').evaluateAll((elements,id)=>elements.find(e=>e.dataset.memberId===id)?.querySelector('img')?.src,people[0].id);
 const before=await Promise.all(surfaces().map(portrait));expect(before.every(Boolean)).toBe(true);
 await request('/contacts/'+people[0].id,{avatar:{...people[0].avatar,seed:'updated-mosaic-avatar'},version:people[0].version,clientId:randomUUID()});
 await page.getByTestId('im-refresh').click();await assertMembers(3);
 for(const [index,avatar] of surfaces().entries())await expect.poll(()=>portrait(avatar)).not.toBe(before[index]);
 const after=await Promise.all(surfaces().map(portrait));expect(after.every(Boolean)).toBe(true);expect(new Set(after).size).toBe(1);
 await editor();await page.getByTestId('im-member-'+people[2].id).check();await expect(preview()).toHaveAttribute('data-member-count','4');
 await page.getByTestId('personal-modal-close').click();await assertMembers(3);
 check('contact changes refresh the collage and cancelling member edits preserves the saved group');
 await editor();await page.emulateMedia({colorScheme:'dark'});await capture('group-editor-dark');
 if(!native){await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await capture('group-editor-narrow-dark');await page.setViewportSize({width:1120,height:900});}
 await page.getByTestId('personal-modal-close').click();
 if(native){
  await application.close();application=null;await launchNative();
  await page.getByTestId('im-chat-'+id).click();await assertMembers(3);await capture('group-after-native-restart');
  check('native restart restores member portraits in the isolated profile');
 }
 const final=await request('/threads/'+id);expect(final.messages).toEqual([]);expect(final.runs).toEqual([]);expect(final.decisions).toEqual([]);expect(errors).toEqual([]);
 check('portrait changes preserve empty conversation and execution state');

}finally{
 await writeFile(join(output,'receipt.json'),JSON.stringify({native,checks,errors,consoleMessages,syntheticOnly:true,browserPlugin:'absent',fallbackReason:'Browser plugin not available; existing repository Playwright setup used',output},null,2)+'\n');
 await application?.close();await browser?.close();await server?.close();console.log(JSON.stringify({output,checks,errors}));
}
