import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { _electron, chromium, expect } = require('@playwright/test');
const root = process.env.AGENTROOM_EVIDENCE_DIR;
if (!root) throw new Error('Set managed AGENTROOM_EVIDENCE_DIR');
const real = process.argv.includes('--real'), publicTest = process.argv.includes('--public');
const output = await mkdtemp(join(root, real ? 'native-real-' : 'native-synthetic-'));
const env = cleanDesktopTestEnv({ ...process.env, AGENTSTUDIO_USER_DATA_DIR: join(output, 'profile'), AGENTSTUDIO_MOCK_KEYCHAIN: '1', AGENTROOM_AUTO_GROUP_NETWORK: publicTest ? '1' : '0', AGENTSTUDIO_WORKSPACE: 'personal', AGENTSTUDIO_CLAUDE_BIN: '/missing-play-claude', AGENTSTUDIO_PI_BIN: '/missing-play-pi' });
if (!real) {
  const home = join(output, 'codex-home'); await mkdir(home);
  await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-local-only' }), { mode: 0o600 });
  await writeFile(join(home, 'config.toml'), 'model="synthetic-model"\nmodel_provider="openai"\nmodel_reasoning_effort="medium"\n');
  const command = join(output, 'synthetic-codex.mjs');
  await writeFile(command, `#!${process.execPath}\nconst a=process.argv.slice(2);const out=x=>console.log(JSON.stringify(x));
if(a.includes('--version'))console.log('codex 0.163.0-synthetic');else if(a.includes('--help'))console.log('--ignore-user-config --ignore-rules');else if(a[0]==='login')console.log('Logged in');else if(a[0]==='features')console.log('apps browser_use browser_use_external computer_use view_image shell_tool unified_exec multi_agent plugins remote_plugin in_app_browser memories hooks skill_search skip_host_skill_discovery');else if(a[0]==='mcp')out([]);else{let p='';for await(const c of process.stdin)p+=c;out({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({action:'reply',text:'合成原生验收：欢迎加入群聊，一起想个有趣的小点子。'})}});out({type:'turn.completed'});}`, { mode: 0o700 });
  env.AGENTSTUDIO_CODEX_BIN = command; env.CODEX_HOME = home;
}
let app, page, browser, guest, priorClipboard, invitation; const checks = [], polls = [];
const report = { realCLI: real, publicTest, syntheticInputsOnly: true, checks, polls, status: 'running' };
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify(report, null, 2));
const check = async value => { checks.push(value); console.log(`PASS ${value}`); await save(); };
const request = async (path, body) => page.evaluate(async ({ path, body }) => {
  const response = await window.agentStudioPersonal.request({ path: `/api${path}`, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body }) });
  if (response.status >= 400) throw new Error(`Owner API returned ${response.status}`); return response.body;
}, { path, body });
try {
  const packaged = process.env.AGENTROOM_TEST_EXECUTABLE;
  app = await launchDesktopTest(_electron, { executablePath: packaged || require('electron'), args: packaged ? [] : [resolve('apps/desktop')], env, timeout: 30000 });
  if (!real) app.process().stderr?.on('data', bytes => { void appendFile(join(output, 'electron-startup.log'), bytes); });
  await writeFile(join(output, 'native-state.json'), JSON.stringify(await app.evaluate(({ app, BrowserWindow }) => ({ ready: app.isReady(), windows: BrowserWindow.getAllWindows().map(win => ({ id: win.id, url: win.webContents.getURL() })) })), null, 2));
  page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1240, height: 900 }));
  await expect(page.getByTestId('im-app')).toBeVisible();
  const contacts = (await request('/contacts')).contacts; assert.ok(contacts.some(c => c.id === 'agent_codex'), 'Codex contact missing');
  const groupPeer=await request('/contacts',{kind:'human',name:'同行朋友',handle:'acceptance-peer',clientId:crypto.randomUUID()});
  const thread = await request('/chats', { kind: 'group', title: '小熊的邀请测试', memberIds: ['agent_codex',groupPeer.id], clientId: crypto.randomUUID() });
  await page.evaluate(id => { location.hash = `#${id}`; location.reload(); }, thread.id);
  await page.getByTestId('group-sharing-open').click(); await page.getByTestId('group-tab-invite').click();
  await page.getByTestId('group-recipe-twin').click(); await page.getByTestId('group-prepare').click(); await page.getByTestId('group-publish').click();
  await check('native trusted IPC publishes a reviewed invitation on an ordinary group');
  const room = await request(`/chats/${thread.id}/sharing`); invitation = await request(`/playrooms/${room.id}/invite`, {});
  priorClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  await page.getByTestId('group-copy-local').click();
  await expect(page.getByTestId('group-copy-local')).toHaveText('已复制本机预览');
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.ok(copied === invitation.localUrl, 'Native copy did not write the scoped local invitation');
  await check('native invitation copy writes the exact scoped URL');
  const invalidCopy = await page.evaluate(async () => { try { await window.agentStudioPersonal.copyPlayInvitation({ roomId: '../private', local: true }); return false; } catch { return true; } });
  assert.ok(invalidCopy, 'Native copy accepted an untrusted target');
  let guestUrl = invitation.localUrl;
  if (publicTest) {
    await request('/play-network', { action: 'start' });
    await expect.poll(async () => (await request('/play-network')).state, { timeout: 45000, intervals: [500, 1000] }).toBe('online');
    invitation = await request(`/playrooms/${room.id}/invite`, {}); guestUrl = invitation.url;
    assert.ok(typeof guestUrl === 'string' && guestUrl.startsWith('https://')); await check('temporary HTTPS invitation address issued');
  }
  const proxyURL = publicTest && (process.env.AGENTROOM_BROWSER_PROXY || process.env.HTTPS_PROXY);
  const proxy = proxyURL ? new URL(proxyURL) : null;
  if (proxy?.username || proxy?.password) throw new Error('Browser proxy authentication requires an explicit test configuration');
  browser = await chromium.launch({ headless: true, ...(proxy ? { proxy: { server: proxy.origin } } : {}) }); guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  guest.on('response', async response => {
    if (!new URL(response.url()).pathname.startsWith('/g-api/')) return;
    try { const body = await response.json(); polls.push({ at: Date.now(), status: response.status(), version: body.version, messages: body.messages?.length, jobs: body.jobs?.map(j => j.status), durationMs: response.request().timing().responseEnd }); } catch { polls.push({ at: Date.now(), status: response.status() }); }
  });
  if (publicTest) {
    await expect.poll(async () => { try { await guest.goto(guestUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }); return await guest.getByTestId('play-nickname').isVisible(); } catch { return false; } }, { timeout: 45000, intervals: [1000, 2000, 3000], message: 'Temporary HTTPS invitation must become reachable, not merely issue a hostname' }).toBe(true);
  } else await guest.goto(guestUrl);
  await guest.getByTestId('play-nickname').fill('来做客的朋友'); await guest.getByTestId('play-join').click();
  await expect(guest.getByTestId('group-guest-chat')).toBeVisible(); await check('anonymous browser accepts invitation and obtains an independent session');
  await guest.getByTestId('group-message').fill('请用一句中文欢迎我，不调用外部能力。'); await guest.getByTestId('group-send').click();
  await expect.poll(async () => { const current = await request(`/playrooms/${room.id}`); return current.jobs[0]?.status; }, { timeout: real ? 120000 : 20000, intervals: [200, 1000] }).toBe('completed');
  const answered = await request(`/playrooms/${room.id}`); const reply = answered.messages.at(-1);
  assert.ok(reply?.role === 'assistant' && reply.text.trim(), 'Assistant did not publish a response');
  await expect(guest.getByTestId('im-timeline')).toContainText(reply.text, { timeout: publicTest ? 30000 : 5000 });
  await guest.screenshot({ path: join(output, 'guest-room.png'), fullPage: true }); await page.screenshot({ path: join(output, 'native-owner-room.png') });
  await check(real ? 'actual configured Codex produces a reply through the restricted native executor' : 'synthetic CLI completes native-to-guest message transport');
  await request(`/chats/${thread.id}/sharing`, { action: 'close', clientId: crypto.randomUUID() });
  await expect(guest.getByTestId('play-connection-state')).toContainText('邀请已结束', { timeout: 10000 });
  await check('owner closes the room and existing guest session loses access'); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.message).replace(/#[A-Za-z0-9_-]{43}/g, '#[invitation]');
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  await guest?.screenshot({ path: join(output, 'guest-failure.png'), fullPage: true }).catch(() => {});
  throw new Error(report.error);
} finally {
  if (app && priorClipboard !== undefined) {
    const current = await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => null);
    if (invitation && current === invitation.localUrl) await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), priorClipboard);
  }
  await browser?.close(); await app?.close(); await save();
}
console.log(`Native playrooms acceptance ${report.status}: ${output}`);
