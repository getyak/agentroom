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
const parent = resolve(process.env.AGENTROOM_CARDS_EVIDENCE_DIR || 'output/playwright/local-agent-cards');
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
  await expect(page.getByTestId('im-local-action-codex')).toContainText('添加并聊天');
  await expect(page.getByTestId('im-contact-editor')).toHaveCount(0);
  await expect(page.getByTestId('im-local-picker').locator('input')).toHaveCount(0);
  if (!native) {
    await expect(page.getByTestId('im-local-action-pi')).toContainText('去登录');
    await expect(page.getByTestId('im-local-candidate-gemini')).not.toBeVisible();
    await page.getByTestId('im-local-other').click();
    await expect(page.getByTestId('im-local-candidate-gemini')).toContainText('暂不支持聊天');
    await expect(page.getByTestId('im-local-action-gemini')).toHaveCount(0);
    await page.getByTestId('im-local-other').click();
  }
  await page.screenshot({ path: join(output, 'selection.png') });
  const adoptionBodies = [];
  if (!native) {
    let rejectAdoption = true, rejectChat = true;
    await page.route('**/api/contacts/local', async route => {
      adoptionBodies.push(route.request().postDataJSON());
      if (rejectAdoption) {
        rejectAdoption = false;
        await route.fetch(); // Commit adoption, then lose the success receipt.
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'synthetic_unavailable', message: '合成添加回执丢失，请重试' } }) });
      }
      return route.continue();
    });
    await page.route('**/api/chats', async route => {
      if (rejectChat) { rejectChat = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'synthetic_unavailable', message: '合成聊天临时失败，请重试' } }) }); }
      return route.continue();
    });
    await page.getByTestId('im-local-action-codex').click();
    await expect(page.getByTestId('im-local-picker')).toContainText('合成添加回执丢失');
    await page.getByTestId('im-local-action-codex').click();
    await expect(page.getByTestId('im-local-picker')).toContainText('合成聊天临时失败');
    expect(adoptionBodies).toHaveLength(2);
    expect(adoptionBodies[0]).toEqual(adoptionBodies[1]);
    await expect(page.getByTestId('im-local-action-codex')).toContainText('打开聊天');
    expect(server.store.get('contact', 'agent_codex').added).toBe(true);
    await page.screenshot({ path: join(output, 'saved-chat-retry.png') });
    checks.push('lost adoption receipt reuses clientId; failed chat open preserves adoption and retries in place');
  }
  await page.getByTestId('im-local-action-codex').click();
  await expect(page.getByTestId('im-message-input')).toBeVisible();
  await expect(page.getByTestId('im-message')).toHaveCount(0);
  checks.push('one click adds the stable local contact and opens chat without sending a message');
  await page.getByTestId('im-chat-info').click();
  const card = page.getByTestId('im-agent-card');
  await expect(card).toContainText('synthetic-model');
  await expect(card).toContainText('high');
  await expect(card).toContainText('这台 Mac');
  await expect(card).toContainText(native ? '额度由模型提供商管理' : '服务尚未提供额度数据');
  await page.screenshot({ path: join(output, 'card-desktop.png') });
  await expect(card.getByTestId('im-agent-card-meter')).toHaveCount(0);
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
  if (!native) { await expect(page.getByTestId('im-contact-agent_pi')).toBeVisible(); expect(server.store.get('contact', 'agent_pi').added).toBe(false); }
  await expect(page.getByTestId('im-contact-agent_gemini')).toBeVisible();
  await page.getByTestId('im-contact-agent_gemini').click();
  await expect(page.getByTestId('im-start-chat')).toBeDisabled();
  await page.getByTestId('im-contact-agent_gemini').dblclick();
  await expect(page.getByTestId('im-error')).toBeVisible();
  await expect(page.getByTestId('im-message-input')).toHaveCount(0);
  if (server) expect(server.store.get('contact', 'agent_gemini').added).toBe(false);
  await page.getByTestId('im-contact-agent_codex').click();
  await expect(page.getByTestId('im-agent-card')).toContainText(native ? '额度由模型提供商管理' : '服务尚未提供额度数据');
  await page.getByTestId('im-local-add-entry').click();
  await expect(page.getByTestId('im-local-action-codex')).toContainText('打开聊天');
  await page.getByTestId('im-local-refresh').click();
  await expect(page.getByTestId('im-local-action-codex')).toBeEnabled();
  await expect(page.getByTestId('im-local-action-codex')).toContainText('打开聊天');
  checks.push('adoption survives reload; refresh creates no duplicates and opens the existing chat');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByTestId('im-local-action-codex')).toBeVisible();
    expect(await page.getByTestId('im-local-picker').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: join(output, `picker-${width}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.screenshot({ path: join(output, 'picker-dark.png') });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 900 });
  if (!native) {
    let releaseRefresh;
    await page.route('**/api/integrations/refresh', async route => {
      await new Promise(resolve => { releaseRefresh = resolve; });
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '合成检查失败' } }) });
    });
    await page.getByTestId('im-local-refresh').click();
    await expect(page.getByTestId('im-local-picker')).toContainText('正在更新助手状态');
    await expect(page.getByTestId('im-local-candidate-codex')).toBeVisible();
    await expect(page.getByTestId('im-local-action-codex')).toBeDisabled();
    await expect.poll(() => typeof releaseRefresh).toBe('function');
    releaseRefresh();
    await expect(page.getByTestId('im-local-picker')).toContainText('合成检查失败');
    await expect(page.getByTestId('im-local-candidate-codex')).toBeVisible();
    await page.unroute('**/api/integrations/refresh');
    await page.getByTestId('im-local-retry').click();
    await expect(page.getByTestId('im-local-action-codex')).toBeEnabled();
    checks.push('refresh preserves rows while pending and on error; retry revalidates before enabling actions');
    await page.getByTestId('im-local-action-pi').click();
    await expect(page.getByTestId('personal-modal')).toContainText('连接');
    expect(server.store.get('contact', 'agent_pi').added).toBe(false);
    await page.getByTestId('personal-modal-close').click();
    await page.getByTestId('im-new').click();
    await expect(page.getByTestId('im-local-picker')).toBeVisible();
    checks.push('signed-out assistant directs to setup without adoption or model execution');
  }
  await page.getByTestId('im-local-customize').click();
  await expect(page.getByTestId('im-contact-editor')).toBeVisible();
  await expect(page.getByTestId('im-contact-handle')).not.toBeVisible();
  await expect(page.getByTestId('im-avatar-mode-robot')).not.toBeVisible();
  await page.getByTestId('im-contact-name').fill('合成研究伙伴');
  await page.getByTestId('im-contact-instructions').fill('只用于合成界面验收。');
  await page.screenshot({ path: join(output, 'custom-role.png') });
  await page.getByTestId('im-contact-advanced').click();
  await page.getByTestId('im-contact-handle').fill('1invalid');
  await page.getByTestId('im-contact-advanced').click();
  await page.getByTestId('im-contact-save').click();
  await expect(page.getByTestId('im-contact-handle')).toBeVisible();
  await expect(page.getByTestId('im-contact-editor')).toBeVisible();
  await page.getByTestId('im-contact-handle').fill('synthetic-partner');
  await page.getByTestId('im-contact-description').fill('合成简介');
  await page.getByTestId('im-model-options-toggle').click();
  await page.getByTestId('im-model-policy').selectOption('fixed');
  await page.getByTestId('im-model-name').fill('');
  await page.getByTestId('im-contact-advanced').click();
  await page.getByTestId('im-contact-save').click();
  await expect(page.getByTestId('im-model-name')).toBeVisible();
  await page.getByTestId('im-model-name').fill('synthetic-model');
  await page.getByTestId('im-contact-advanced').click();
  await page.getByTestId('im-contact-save').click();
  await expect(page.getByTestId('im-contact-detail')).toContainText('合成研究伙伴');
  await page.getByTestId('im-edit-contact').click();
  await page.getByTestId('im-contact-advanced').click();
  await expect(page.getByTestId('im-contact-description')).toHaveValue('合成简介');
  await page.getByTestId('personal-modal-close').click();
  await page.getByTestId('im-new').click();
  await page.getByTestId('im-local-human').click();
  await expect(page.getByTestId('im-contact-backend')).toHaveCount(0);
  await page.getByTestId('im-contact-name').fill('合成人类联系人');
  await page.getByTestId('im-contact-save').click();
  await expect(page.getByTestId('im-contact-detail')).toContainText('合成人类联系人');
  checks.push('secondary role/human creation works; closed disclosures preserve custom fields');
  await page.getByTestId('im-new').click();
  await page.getByTestId('im-local-action-codex').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('im-message-input')).toBeVisible();
  if (server) {
    expect(server.store.list('thread').filter(thread => thread.memberIds?.includes('agent_codex')).length).toBe(1);
    expect(server.store.list('thread').flatMap(thread => thread.runs)).toHaveLength(0);
    expect(server.store.list('contact').filter(c => c.id === 'agent_codex')).toHaveLength(1);
    await page.getByTestId('im-nav-contacts').click();
    await page.getByTestId('im-new').click();
    detected.agents = [];
    await page.getByTestId('im-local-refresh').click();
    await expect(page.getByTestId('im-local-empty')).toContainText('还没有找到本机助手');
    await expect(page.getByTestId('im-local-connect-empty')).toBeEnabled();
    checks.push('empty discovery offers connection; keyboard open reuses the original chat and no model ran');
  }
  const unexpectedErrors = errors.filter(error => !(!native && error.includes('503 (Service Unavailable)')));
  expect(unexpectedErrors).toEqual([]);
  await writeFile(join(output, 'checks.json'), JSON.stringify({ checks, errors, unexpectedErrors, expectedFailures: native ? [] : ['adoption receipt HTTP 503', 'chat HTTP 503', 'refresh HTTP 503'], url: page.url(), title: await page.title(), synthetic: true }, null, 2));
  console.log(JSON.stringify({ checks, errors, output }, null, 2));
} catch (e) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw e;
} finally { await browser?.close(); await application?.close(); await server?.close(); }
