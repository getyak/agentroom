import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';
// Synthetic browser/native acceptance; --real uses the configured local Codex with synthetic sources only.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';
const desktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium, _electron } = createRequire(desktop.resolve('@playwright/test'))('playwright');
const { expect } = desktop('@playwright/test');
const native = process.argv.includes('--native'), real = process.argv.includes('--real');
const parent = process.env.AGENTSTUDIO_MESSENGER_EVIDENCE_DIR || resolve('output/playwright/agent-onboarding'); await mkdir(parent, { recursive: true });
const output = await mkdtemp(join(parent, real ? 'onboarding-real-' : native ? 'onboarding-native-' : 'onboarding-browser-'));
const cli = join(output, 'synthetic-codex'), codexHome = join(output, 'codex-home'); await mkdir(codexHome);
await writeFile(join(codexHome, 'config.toml'), 'model="synthetic-model"\nmodel_provider="synthetic"\nmodel_reasoning_effort="low"\n');
await writeFile(cli, `#!${process.execPath}
if(process.argv.includes('--version')){console.log('codex 0.0.1-synthetic');process.exit(0)}
if(process.argv.includes('login')){console.log('Logged in');process.exit(0)}
let p='';for await(const c of process.stdin)p+=c;
let result;
if(p.includes('onboarding availability probe')){result={status:'ok',challenge:p.match(/challenge: ([a-zA-Z0-9_-]+)/)[1]};}
else if(p.includes('<untrusted_onboarding_context>')){const c=JSON.parse(p.split('<untrusted_onboarding_context>\\n')[1].split('\\n</untrusted_onboarding_context>')[0]);const g=c.sources.find(x=>x.kind==='group');result={suggestions:[{name:'合成审查伙伴',handle:'synthetic-reviewer',description:'这是合成验收角色，不代表真实模型建议。',instructions:'核对讨论中的证据。仅在有帮助时回应；不相关时保持安静。',rationale:'合成验收：当前群聊需要发布前的独立检查。',sourceIds:[g.id],groupIds:[g.targetId]}],habits:[]};}
else {const c=JSON.parse(p.split('<untrusted_thread_context>\\n')[1].split('\\n</untrusted_thread_context>')[0]);const text=c.messages.at(-1).text;result=p.includes('Group participation:')?(text.includes('保持安静')?{action:'silence',reason:'合成验收：此条无需回应'}:{action:'reply',text:'这是合成验收回复，身份是'+c.agentIdentity.name}):'合成验收普通回复';}
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:typeof result==='string'?result:JSON.stringify(result)}}));console.log(JSON.stringify({type:'turn.completed'}));
`, { mode: 0o700 });
let server, browser, app, page; const checks = [], errors = [];
const request = async (path, body) => {
 if (native) return page.evaluate(async ({path,body})=>{const r=await window.agentStudioPersonal.request({path:'/api'+path,method:body?'POST':'GET',...(body?{body}:{})});if(r.status>=400)throw new Error(JSON.stringify(r.body));return r.body;},{path,body});
 const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});if(!r.ok)throw new Error(await r.text());return r.json();
};
const check = text => { checks.push(text); console.log('PASS '+text); };
try {
 const env = {...process.env,AGENTSTUDIO_MOCK_KEYCHAIN:'1',AGENTSTUDIO_WORKSPACE:'personal',AGENTSTUDIO_USER_DATA_DIR:join(output,'profile')};
 cleanDesktopTestEnv(env);
 for(const k of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','AGENTSTUDIO_PERSONAL_DATA_DIR','PERSONAL_DATA_DIR'])delete env[k];
 if(!real)Object.assign(env,{CODEX_HOME:codexHome,AGENTSTUDIO_CODEX_BIN:cli,AGENTSTUDIO_CLAUDE_BIN:'/synthetic-missing-claude',AGENTSTUDIO_PI_BIN:'/synthetic-missing-pi'});
 if(native){app=await launchDesktopTest(_electron, {executablePath:desktop('electron'),args:[resolve('apps/desktop')],env,timeout:30000});page=await app.firstWindow();}
 else{server=await createPersonalServer({dataDir:join(output,'data'),port:0,...(!real?{codexCommand:cli,localAgentDeps:{env,commands:{claude:'/synthetic-missing-claude',pi:'/synthetic-missing-pi'}}}:{}),staticDir:resolve('apps/personal/dist')});await server.listen();browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{channel:'chrome'}:{})});page=await browser.newPage({viewport:{width:1200,height:850}});await page.goto(`http://127.0.0.1:${server.address().port}`);}
 page.on('pageerror',e=>errors.push(e.message));await expect(page.getByTestId('im-app')).toBeVisible();
 const contacts=await request('/contacts');expect(contacts.contacts.find(c=>c.id==='agent_codex').availability).toBe('ready');
 const groupPeer=await request('/contacts',{kind:'human',name:'同行朋友',handle:'acceptance-peer',clientId:crypto.randomUUID()});
  const group=await request('/chats',{kind:'group',title:'合成发布讨论',memberIds:['agent_codex',groupPeer.id],clientId:crypto.randomUUID()});
 await request(`/threads/${group.id}/messages`,{text:'这是隔离验收。请保持安静，无需公开回复。',clientId:crypto.randomUUID()});
 let completed;await expect.poll(async()=>{completed=await request(`/threads/${group.id}`);return completed.runs[0]?.status;},{timeout:real?180000:15000}).toBe('completed');
 expect(completed.runs[0].participation.action).toBe('silence');expect(completed.messages).toHaveLength(1);expect(completed.artifacts).toHaveLength(0);check('ambient group message reaches the agent, which can complete silently');
 await request(`/threads/${group.id}/messages`,{text:'@codex 这是合成验收，请简短回应你当前配置的名称。不要调用工具。',clientId:crypto.randomUUID()});
 await expect.poll(async()=>{completed=await request(`/threads/${group.id}`);return completed.runs.at(-1)?.status;},{timeout:real?180000:15000}).toBe('completed');expect(completed.messages.filter(m=>m.role==='assistant')).toHaveLength(1);check('explicit attention produces attributed text without protocol JSON');
 await page.getByTestId('im-nav-contacts').click();await page.getByTestId('im-onboarding-open').click();await expect(page.getByTestId('im-onboarding')).toBeVisible();
 await page.getByTestId('im-onboarding-goal').fill('这是合成验收，请基于合成发布讨论建议一个审查伙伴。不要推断不存在的历史习惯。');
 await page.getByTestId('im-onboarding-context').click();await expect(page.getByTestId('im-onboarding')).toContainText('合成发布讨论');
 await page.getByTestId('im-onboarding-start').click();
 await expect(page.getByTestId('im-role-suggestion').first()).toBeVisible({timeout:real?300000:20000});check('actual configured adapter passes challenge before grounded role suggestions appear');
 expect((await request('/agent-onboarding')).jobs[0].probe.status).toBe('passed');
 await page.screenshot({path:join(output,'suggestions.png')});
 await page.reload();await page.getByTestId('im-nav-contacts').click();await page.getByTestId('im-onboarding-open').click();await expect(page.getByTestId('im-role-suggestion').first()).toBeVisible();check('reload recovers the durable suggestion and its evidence');
 const before=(await request('/contacts')).contacts.length;await page.getByTestId('im-adopt-role').first().click();await expect(page.getByTestId('im-adopt-role').first()).toContainText('已添加');expect((await request('/contacts')).contacts.length).toBe(before+1);check('explicit adoption creates one model-bound contact without joining existing groups');
 const job=(await request('/agent-onboarding')).jobs[0];expect((await request(`/threads/${group.id}`)).memberIds).toEqual(group.memberIds);expect((await request('/bootstrap')).threads.some(t=>t.id===job.threadId)).toBe(false);
 await page.screenshot({path:join(output,'adopted.png')});
 if(!native){await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'dark'});await expect(page.getByTestId('im-role-suggestion').first()).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:join(output,'narrow-dark.png')});check('narrow dark view keeps the role preview readable');}
 expect(errors).toEqual([]);await writeFile(join(output,'runtime.json'),JSON.stringify(await request('/health'),null,2));
} finally {await writeFile(join(output,'receipt.json'),JSON.stringify({native,real,syntheticSourcesOnly:true,checks,errors,output},null,2));await app?.close();await browser?.close();await server?.close();console.log(JSON.stringify({output,checks,errors}));}
