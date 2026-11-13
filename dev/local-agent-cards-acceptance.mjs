// Isolated synthetic acceptance; no real login, model or provider quota calls.
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';
import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';
const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium, _electron } = createRequire(requireDesktop.resolve('@playwright/test'))('playwright');
const { expect } = requireDesktop('@playwright/test');
const native = process.argv.includes('--native');
const parent = resolve(process.env.AGENTROOM_CARDS_EVIDENCE_DIR || '/tmp/agentroom-cards-acceptance');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(join(parent, native ? 'native-' : 'browser-'));
const profile = { agentId: 'codex', defaults: { provider: 'synthetic', model: 'synthetic-model', thinking: 'high' }, models: [], providers: ['synthetic'], thinkingLevels: ['low', 'high'], modelThinkingLevels: {}, source: 'synthetic fixture', version: 'fixture-1', description: '' };
const detected = { checkedAt: new Date().toISOString(), agents: [
  { id: 'codex', name: 'Codex', installed: true, version: '1.2.3', auth: { status: 'configured' }, execution: { supported: true }, profile },
  { id: 'pi', name: 'Pi', installed: true, version: '1.2.3', auth: { status: 'required' }, execution: { supported: true } },
  { id: 'gemini', name: 'Gemini CLI', installed: true, version: '1.2.3', auth: { status: 'unknown' }, execution: { supported: false } },
] };
let server, browser, application, page;
if (native) {
  const home = join(output, 'synthetic-home'); await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.toml'), 'model="synthetic-model"\nmodel_provider="synthetic"\nmodel_reasoning_effort="high"\n');
  const cli = join(output, 'synthetic-codex');
  await writeFile(cli, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('codex 1.2.3');else if(process.argv.includes('login'))console.log('Logged in');else process.exitCode=1;\n`, { mode: 0o700 });
  const env = { ...process.env, CODEX_HOME: home, AGENTSTUDIO_USER_DATA_DIR: join(output, 'native-profile'), AGENTSTUDIO_WORKSPACE: 'personal', AGENTSTUDIO_MOCK_KEYCHAIN: '1' };
  cleanDesktopTestEnv(env);
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AGENTSTUDIO_PERSONAL_DATA_DIR', 'PERSONAL_DATA_DIR', 'AGENTROOM_TEST_MODE', 'AGENTROOM_USER_DATA_DIR', 'AGENTROOM_PERSONAL_DATA_DIR']) delete env[name];
  for (const id of ['CODEX', 'CLAUDE', 'PI', 'GEMINI', 'OPENCODE']) env[`AGENTSTUDIO_${id}_BIN`] = id === 'CODEX' ? cli : '/missing-agentroom-synthetic';
  application = await launchDesktopTest(_electron, { executablePath: requireDesktop('electron'), args: [resolve('apps/desktop')], env });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 900 }));
} else {
  server = await createPersonalServer({ dataDir: join(output, 'data'), port: 0, discoverLocalAgents: async () => detected, staticDir: resolve('apps/personal/dist') });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
}
const errors = []; page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const checks = [];
try {
  if (!native) await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.getByTestId('workspace-guide')).toBeVisible();
  await page.getByTestId('workspace-guide-local').click();
  await expect(page.getByTestId('im-local-picker')).toBeVisible();
  if (!native) await expect(page.getByTestId('im-local-select-gemini')).toBeDisabled();
  await page.getByTestId('im-local-select-codex').check();
  if (!native) await page.getByTestId('im-local-select-pi').check();
  await page.screenshot({ path: join(output, 'selection.png') });
  await page.getByTestId('im-local-add').click();
  await expect(page.getByTestId('im-local-result')).toContainText(native ? '1' : '2');
  await expect(page.getByTestId('im-local-select-codex')).toBeDisabled();
  if (!native) {
    let rejectFirst = true;
    await page.route('**/api/chats', async route => {
      if (rejectFirst) { rejectFirst = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'synthetic_unavailable', message: '合成临时失败，请重试' } }) }); }
      return route.continue();
    });
    await page.getByTestId('im-local-chat').click();
    await expect(page.getByTestId('im-local-result')).toBeVisible();
    await expect(page.getByTestId('im-local-picker')).toContainText('合成临时失败');
    checks.push('a failed chat open keeps the saved result and supports retry in place');
  }
  await page.getByTestId('im-local-chat').click();
  await expect(page.getByTestId('im-message-input')).toBeVisible();
  await expect(page.getByTestId('im-message')).toHaveCount(0);
  checks.push('welcome selection adds stable contacts without sending a message');
  await page.getByTestId('im-chat-info').click();
  const card = page.getByTestId('im-agent-card');
  await expect(card).toContainText('synthetic-model');
  await expect(card).toContainText('high');
  await expect(card).toContainText('这台 Mac');
  await expect(card).toContainText('暂不可获取');
  await page.screenshot({ path: join(output, 'card-desktop.png') });
  checks.push('chat-header card shows model, thinking, location, capabilities and unknown quota');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(output, 'card-narrow.png') });
  checks.push('card remains readable at 390px without horizontal overflow');
  const before = server?.store.list('contact').filter(c => c.added).map(c => c.id).sort();
  await page.reload();
  if (server) {
    expect(server.store.list('contact').filter(c => c.added).map(c => c.id).sort()).toEqual(before);
    expect(server.store.list('thread').filter(thread => !thread.memberIds?.includes('agentroom_guide')).length).toBe(1);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId('im-nav-contacts').click();
  if (!native) await expect(page.getByTestId('im-contact-agent_pi')).toBeVisible();
  await expect(page.getByTestId('im-contact-agent_gemini')).toBeVisible();
  await page.getByTestId('im-contact-agent_gemini').click();
  await expect(page.getByTestId('im-start-chat')).toBeDisabled();
  await page.getByTestId('im-contact-agent_codex').click();
  await expect(page.getByTestId('im-agent-card')).toContainText('暂不可获取');
  await page.getByTestId('im-local-add-entry').click();
  await expect(page.getByTestId('im-local-select-codex')).toBeDisabled();
  await page.getByTestId('im-local-refresh').click();
  await expect(page.getByTestId('im-local-select-codex')).toBeDisabled();
  checks.push(native ? 'native adoption survives reload; refresh creates no duplicates' : 'adopted signed-out agent stays visible; unsupported candidate stays out of contacts; refresh creates no duplicates');
  const unexpectedErrors = errors.filter(error => !(!native && error.includes('503 (Service Unavailable)')));
  expect(unexpectedErrors).toEqual([]);
  await writeFile(join(output, 'checks.json'), JSON.stringify({ checks, errors, unexpectedErrors, expectedFailures: native ? [] : ['one synthetic /chats HTTP 503'], url: page.url(), title: await page.title(), synthetic: true }, null, 2));
  console.log(JSON.stringify({ checks, errors, output }, null, 2));
} catch (e) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw e;
} finally { await browser?.close(); await application?.close(); await server?.close(); }
