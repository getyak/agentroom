// Synthetic browser/native IM acceptance. Never calls a real model or account.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';
import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';

const desktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium, _electron } = createRequire(desktop.resolve('@playwright/test'))('playwright');
const { expect } = desktop('@playwright/test');
const native = process.argv.includes('--native');
const parent = resolve(process.env.AGENTSTUDIO_MESSENGER_EVIDENCE_DIR || 'output/playwright/group-im');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(join(parent, native ? 'native-' : 'browser-'));
const home = join(output, 'codex-home'), cli = join(output, 'synthetic-codex'), release = join(output, 'release');
await mkdir(home);
await writeFile(join(home, 'config.toml'), 'model="synthetic-model"\nmodel_provider="synthetic"\nmodel_reasoning_effort="low"\n');
await writeFile(cli, `#!${process.execPath}
import {existsSync} from 'node:fs';import {watch} from 'node:fs/promises';
if(process.argv.includes('--version')){console.log('codex 0.0.1-synthetic');process.exit(0)}
if(process.argv.includes('login')){console.log('Logged in');process.exit(0)}
let prompt='';for await(const part of process.stdin)prompt+=part;
const c=JSON.parse(prompt.split('<untrusted_thread_context>\\n')[1].split('\\n</untrusted_thread_context>')[0]);
const handle=c.agentIdentity.handle;
if(handle==='slow-reader'&&!existsSync(${JSON.stringify(release)})){for await(const event of watch(${JSON.stringify(output)})){if(existsSync(${JSON.stringify(release)}))break;}}
const result=handle==='quiet-reader'?{action:'silence',reason:'此条无需补充'}:handle==='reactor'?{action:'reaction',emoji:'👍'}:{action:'reply',text:'我已经核对了这条消息，其他伙伴可以独立回应。'};
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));console.log(JSON.stringify({type:'turn.completed'}));
`, { mode: 0o700 });
let server, browser, app, page;
const checks = [], errors = [], clientId = () => crypto.randomUUID();
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const request = async (path, body) => {
  if (native) return page.evaluate(async ({ path, body }) => {
    const response = await window.agentStudioPersonal.request({ path: `/api${path}`, method: body ? 'POST' : 'GET', ...(body ? { body } : {}) });
    if (response.status >= 400) throw new Error(JSON.stringify(response.body));
    return response.body;
  }, { path, body });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(await response.text()); return response.json();
};
try {
  if (native) {
    const env = { ...process.env, CODEX_HOME: home, AGENTSTUDIO_MOCK_KEYCHAIN: '1', AGENTSTUDIO_WORKSPACE: 'personal', AGENTSTUDIO_USER_DATA_DIR: join(output, 'profile'), AGENTSTUDIO_CODEX_BIN: cli, AGENTSTUDIO_PI_BIN: '/synthetic-missing-pi', AGENTSTUDIO_CLAUDE_BIN: '/synthetic-missing-claude' };
    cleanDesktopTestEnv(env);
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AGENTSTUDIO_PERSONAL_DATA_DIR', 'PERSONAL_DATA_DIR']) delete env[key];
    const packaged = process.env.AGENTSTUDIO_PACKAGED_APP;
    app = await launchDesktopTest(_electron, { executablePath: packaged ? join(packaged, 'Contents/MacOS/AgentRoom') : desktop('electron'), args: packaged ? [] : [resolve('apps/desktop')], env, timeout: 30000 });
    page = await app.firstWindow(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1200, height: 820 }));
  } else {
    server = await createPersonalServer({ dataDir: join(output, 'data'), port: 0, staticDir: resolve('apps/personal/dist'), codexCommand: cli, localAgentDeps: { env: { ...process.env, CODEX_HOME: home }, commands: { pi: '/synthetic-missing-pi', claude: '/synthetic-missing-claude' } } });
    await server.listen(); browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
    page = await browser.newPage({ viewport: { width: 1200, height: 820 } }); await page.goto(`http://127.0.0.1:${server.address().port}`);
  }
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByTestId('im-app')).toBeVisible();
  await request('/workspace/onboarding', { action: 'complete', name: '合成验收', clientId: clientId() });
  await request('/contacts');
  const members = [];
  for (const [handle, name] of [['slow-reader', '慢速研究伙伴'], ['reactor', '表情伙伴'], ['quiet-reader', '安静伙伴']]) members.push((await request('/contacts', { kind: 'agent', name, handle, instructions: '按自己的风格参与；没有必要时保持安静。', binding: { type: 'local', localAgentId: 'codex' }, clientId: clientId() })).id);
  const chat = await request('/chats', { kind: 'group', title: '并行群聊验收', memberIds: members, clientId: clientId() });
  if (native) await page.evaluate(id => { const url = new URL(location.href); url.searchParams.set('thread', id); history.replaceState(null, '', url); location.reload(); }, chat.id);
  else await page.goto(`http://127.0.0.1:${server.address().port}/?thread=${chat.id}`);
  await expect(page.getByTestId('im-message-input')).toBeVisible();
  await page.getByTestId('im-message-input').fill('这条消息请各自读取，有补充再回应。'); await page.getByTestId('im-send').click();
  let observed;
  await expect.poll(async () => { observed = await request(`/threads/${chat.id}`); return observed.runs.filter(run => run.status === 'completed').length; }, { timeout: 20000 }).toBe(2);
  expect(observed.runs.find(run => run.contactId === members[0]).status).toBe('running');
  await expect(page.getByTestId('im-run-status')).toHaveCount(0);
  const messageId = observed.messages[0].id;
  await expect(page.getByTestId(`im-reaction-${messageId}-👍`)).toBeVisible();
  await expect(page.getByTestId(`im-read-${messageId}`)).toHaveCount(0);
  await expect(page.getByTestId(`im-reaction-${messageId}-👍`)).toHaveText('👍');
  check('reaction and silence complete while a slow group member remains running; no queued reply slots');
  await page.screenshot({ path: join(output, 'concurrent-group.png') });
  await writeFile(release, 'release synthetic reader');
  await expect.poll(async () => (await request(`/threads/${chat.id}`)).runs.every(run => run.status === 'completed')).toBe(true);
  await expect(page.getByTestId('im-message-content').filter({ hasText: '我已经核对了这条消息' })).toHaveCount(1);
  await page.getByTestId(`im-reaction-${messageId}-👍`).click();
  await expect(page.getByTestId(`im-reaction-${messageId}-👍`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId(`im-reaction-${messageId}-👍`)).toHaveText('👍2');
  await page.getByTestId(`im-reaction-${messageId}-👍`).click();
  await expect(page.getByTestId(`im-reaction-${messageId}-👍`)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId(`im-reaction-${messageId}-👍`)).toHaveText('👍');
  await page.getByTestId(`im-react-${messageId}`).click();
  await page.getByTestId(`im-react-choice-${messageId}-🎉`).click();
  await expect(page.getByTestId(`im-reaction-${messageId}-🎉`)).toBeVisible();
  check('owner can add and remove reactions without replacing the agent reaction');
  await page.getByTestId('im-settings').click(); await page.getByTestId('personal-tab-im').click();
  await expect(page.getByTestId('im-allow-silence')).toBeChecked();
  await page.getByTestId('im-allow-silence').uncheck();
  await expect.poll(async () => (await request('/im/settings')).allowSilence).toBe(false);
  await page.getByTestId('im-allow-silence').check();
  await expect.poll(async () => (await request('/im/settings')).allowSilence).toBe(true);
  await page.screenshot({ path: join(output, 'im-settings.png') });
  await page.keyboard.press('Escape');
  await page.getByTestId('im-chat-info').click();
  await page.getByTestId('im-group-settings-toggle').click();
  await page.getByTestId('im-group-silence').selectOption('require'); await page.getByTestId('im-group-save').click();
  await expect.poll(async () => (await request(`/threads/${chat.id}`)).allowSilence).toBe(false);
  check('IM default and group override persist through native/API controls');
  await page.reload();
  await expect(page.getByTestId(`im-reaction-${messageId}-🎉`)).toBeVisible();
  await expect(page.getByTestId(`im-read-${messageId}`)).toHaveCount(0);
  await expect(page.getByTestId(`im-reaction-${messageId}-🎉`)).toHaveText('🎉');
  if (!native) await page.setViewportSize({ width: 460, height: 800 });
  await page.screenshot({ path: join(output, 'reactions-restored.png') });
  expect(errors).toEqual([]); check('reactions survive reload with single counts and read receipts hidden, with no renderer errors');
} finally {
  await writeFile(release, 'release on cleanup');
  await writeFile(join(output, 'checks.json'), JSON.stringify({ native, checks, errors }, null, 2));
  await app?.close(); await browser?.close(); await server?.close();
  console.log(`Evidence: ${output}`);
}
