// Isolated UI contracts. All install/version endpoints are synthetic; no packages or models run.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const output = resolve(process.env.AGENTROOM_ASSISTANT_UI_EVIDENCE_DIR || 'output/playwright/assistant-management');
await mkdir(output, { recursive: true });
const now = new Date().toISOString();
const profile = { agentId: 'codex', defaults: { provider: 'synthetic', model: 'synthetic-model', thinking: 'high' }, models: [], providers: ['synthetic'], thinkingLevels: ['low', 'high'], modelThinkingLevels: {}, source: 'synthetic fixture', version: 'fixture-1', description: '' };
const inventory = { checkedAt: now, agents: [{ id: 'codex', name: 'Codex', installed: true, version: '1.0.0', auth: { status: 'configured' }, execution: { supported: true }, profile }] };
const entry = (id, name, fields = {}) => ({ id, localAgentId: id, name, description: '合成助手，仅验证管理界面。', kind: 'native', installed: false, installedVersion: null, latestVersion: '2.0.0', updateAvailable: false, installSupported: true, source: null, path: null, repository: 'https://example.invalid/synthetic', ...fields });
const catalog = { checkedAt: now, source: { status: 'fresh', checkedAt: now }, entries: [
  entry('codex', 'Codex', { installed: true, installedVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, source: 'system', path: '/synthetic/codex' }),
  entry('gemini', 'Gemini CLI'),
  entry('acp_fixture', '研究伙伴', { kind: 'acp', latestVersion: '3.0.0' }),
  entry('acp_unsupported', '需要其他运行环境的伙伴', { kind: 'acp', installSupported: false, reason: '当前系统暂不支持这种安装方式。' }),
], operations: [{ id: 'historical-result', agentId: 'acp_fixture', action: 'install', version: '2.0.0', state: 'succeeded', progress: '旧版本安装记录', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] };
const host = await createPersonalServer({ dataDir: join(output, `data-${Date.now()}`), port: 0, staticDir: resolve('apps/personal/dist'), autoGroupNetwork: false, discoverLocalAgents: async () => inventory });
let browser, page;
const bodies = [], errors = [], checks = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
let status = 'failed', concealFirstReceipt = true, lostJob, refreshFailure = false, versionConflict = true, catalogReads = 0;
try {
  host.store.put('setting', { id: 'workspace-onboarding', completed: true });
  await host.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  page.on('pageerror', error => errors.push(error.message));
  const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/assistants', route => { catalogReads++; return fulfill(route, catalogReads === 1 ? { ...catalog, source: { ...catalog.source, refreshing: true }, entries: catalog.entries.slice(0, 1) } : catalog); });
  await page.route('**/api/assistants/refresh', route => refreshFailure ? fulfill(route, { error: { code: 'fixture_offline', message: '合成网络暂不可用' } }, 503) : fulfill(route, catalog));
  await page.route('**/api/assistants/install', route => {
    const body = route.request().postDataJSON(); bodies.push(body);
    if (body.agentId === 'acp_fixture') {
      if (!lostJob) lostJob = { id: 'fixture-install', agentId: body.agentId, action: body.action, version: body.expectedVersion, state: 'running', progress: '正在安装已选择的版本…', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      if (concealFirstReceipt) { concealFirstReceipt = false; return fulfill(route, { error: { code: 'receipt_lost', message: '合成安装回执丢失' } }, 503); }
      catalog.operations = [lostJob, ...catalog.operations.filter(operation => operation.id !== lostJob.id)];
      return fulfill(route, lostJob);
    }
    if (body.agentId === 'gemini' && versionConflict) {
      versionConflict = false; catalog.entries.find(item => item.id === 'gemini').latestVersion = '2.0.1';
      return fulfill(route, { error: { code: 'version_changed', message: '版本已变化' } }, 409);
    }
    const operation = { id: `job-${bodies.length}`, agentId: body.agentId, action: body.action, version: body.expectedVersion, state: 'running', progress: '等待合成安装完成', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    catalog.operations = [operation, ...catalog.operations]; return fulfill(route, operation);
  });
  await page.goto(`http://127.0.0.1:${host.address().port}`);
  const open = async () => { await page.getByTestId('im-new').click(); await page.getByTestId('im-new-contact').click(); await expect(page.getByTestId('im-local-picker')).toBeVisible(); };
  await open();
  await expect(page.getByTestId('im-local-action-codex')).toContainText('添加并聊天');
  await expect(page.getByTestId('im-assistant-update-codex')).toContainText('1.1.0');
  assert.equal(bodies.length, 0);
  await page.getByTestId('im-local-tab-local').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('im-local-tab-discover')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('im-assistant-entry-acp_fixture')).toContainText('ACP 适配器');
  assert.ok(catalogReads >= 2, 'A refreshing catalog is observed automatically without a manual refresh');
  await page.getByTestId('im-local-search').fill('不存在的伙伴');
  await expect(page.getByTestId('im-assistant-catalog-empty')).toContainText('没有找到');
  await page.getByTestId('im-local-search-clear').click();
  await expect(page.getByTestId('im-assistant-install-action-acp_unsupported')).toBeDisabled();
  await page.screenshot({ path: join(output, '01-discover-desktop.png') });
  check('local/discover tabs, keyboard navigation and search expose a catalog without installing');

  await page.getByTestId('im-assistant-install-action-acp_fixture').click();
  await expect(page.getByTestId('im-assistant-retry-acp_fixture')).toHaveText('核对原请求');
  catalog.entries.find(item => item.id === 'acp_fixture').latestVersion = '4.0.0';
  await page.getByTestId('personal-modal-close').click(); await open();
  await page.getByTestId('im-local-tab-discover').click();
  await expect(page.getByTestId('im-assistant-retry-acp_fixture')).toHaveText('核对原请求');
  await page.getByTestId('im-assistant-retry-acp_fixture').click();
  await expect(page.getByTestId('im-assistant-progress-acp_fixture')).toBeVisible();
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(bodies[1].expectedVersion, '3.0.0');
  lostJob.state = 'succeeded'; lostJob.updatedAt = new Date().toISOString(); lostJob.progress = '安装完成';
  Object.assign(catalog.entries.find(item => item.id === 'acp_fixture'), { installed: true, installedVersion: '3.0.0', source: 'managed', path: '/synthetic/managed/3.0.0/assistant', updateAvailable: true });
  inventory.agents.push({ id: 'acp_fixture', name: '研究伙伴', installed: true, version: '3.0.0', auth: { status: 'unknown' }, execution: { supported: true, protocol: 'acp' }, profile: { ...profile, agentId: 'acp_fixture', defaults: { provider: null, model: null, thinking: null }, protocol: 'acp' } });
  await expect(page.getByTestId('im-assistant-update-acp_fixture')).toContainText('4.0.0');
  await page.getByTestId('im-local-tab-local').click();
  await expect(page.getByTestId('im-local-candidate-acp_fixture')).toBeVisible();
  const added = host.store.list('contact').filter(contact => contact.added === true && contact.id !== 'self');
  assert.equal(added.length, 0, 'Installing a catalog item must not adopt a contact automatically');
  check('ambiguous install reuses its original version/clientId despite refresh; success refreshes local discovery');

  refreshFailure = true;
  await page.getByTestId('im-assistant-catalog-refresh').click();
  await expect(page.getByTestId('im-assistant-catalog-error')).toContainText('合成网络');
  await expect(page.getByTestId('im-local-action-codex')).toBeEnabled();
  refreshFailure = false;
  await page.getByTestId('im-local-tab-discover').click();
  await page.getByTestId('im-assistant-install-action-gemini').click();
  await expect(page.getByTestId('im-assistant-error-gemini')).toContainText('版本已变化');
  await expect(page.getByTestId('im-assistant-install-action-gemini')).toContainText('2.0.1');
  const conflictBody = bodies.at(-1);
  await page.getByTestId('im-assistant-install-action-gemini').click();
  await expect(page.getByTestId('im-assistant-progress-gemini')).toBeVisible();
  assert.notEqual(bodies.at(-1).clientId, conflictBody.clientId);
  assert.equal(bodies.at(-1).expectedVersion, '2.0.1');
  check('offline catalog leaves local chat available; version conflicts refresh and require a new explicit action');

  for (const [width, height, mode] of [[1200, 850, 'dark'], [560, 720, 'light'], [390, 680, 'light'], [820, 480, 'light']]) {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
    await expect(page.getByTestId('im-local-search')).toBeInViewport();
    await expect(page.getByTestId('im-local-connect')).toBeInViewport();
    assert.ok(await page.getByTestId('im-local-picker').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: join(output, `02-layout-${width}-${height}-${mode}.png`) });
  }
  const count = bodies.length;
  await page.getByTestId('personal-modal-close').click();
  await page.setViewportSize({ width: 1200, height: 850 }); await open();
  await page.getByTestId('im-local-tab-discover').click();
  await expect(page.getByTestId('im-assistant-progress-gemini')).toBeVisible();
  assert.equal(bodies.length, count);
  check('responsive/dark layouts keep search and footer visible; reopening observes existing jobs without restarting them');

  await page.getByTestId('personal-modal-close').click();
  let cachedInventory = structuredClone(inventory), forcedInventoryReads = 0;
  await page.route('**/api/integrations', route => fulfill(route, cachedInventory));
  await page.route('**/api/integrations/refresh', route => {
    forcedInventoryReads++; cachedInventory = structuredClone(inventory); return fulfill(route, cachedInventory);
  });
  const geminiJob = catalog.operations.find(operation => operation.agentId === 'gemini');
  geminiJob.state = 'succeeded'; geminiJob.progress = '在弹窗关闭期间完成'; geminiJob.updatedAt = new Date().toISOString();
  Object.assign(catalog.entries.find(item => item.id === 'gemini'), { installed: true, installedVersion: '2.0.1', source: 'managed', path: '/synthetic/managed/gemini/2.0.1', updateAvailable: false });
  inventory.agents.push({ id: 'gemini', name: 'Gemini CLI', installed: true, version: '2.0.1', auth: { status: 'unknown' }, execution: { supported: true, protocol: 'acp' }, profile: { ...profile, agentId: 'gemini', defaults: { provider: null, model: null, thinking: null }, protocol: 'acp' } });
  await open();
  await expect(page.getByTestId('im-local-candidate-gemini')).toBeVisible();
  assert.equal(forcedInventoryReads, 1, 'An unseen completion refreshes the inventory once even in the first snapshot');
  await page.getByTestId('personal-modal-close').click(); await open();
  await expect(page.getByTestId('im-local-candidate-gemini')).toBeVisible();
  await expect(page.getByTestId('im-assistant-catalog-status')).toContainText('目录每天自动检查');
  await expect(page.getByTestId('im-local-action-codex')).toBeEnabled();
  assert.equal(forcedInventoryReads, 1, 'An observed completion must not trigger refreshes on every reopening');
  assert.equal(bodies.length, count, 'Reconciliation does not submit another installation');
  check('a job completed while closed refreshes stale local inventory once and stays reconciled across reopening');
  assert.deepEqual(errors, []); status = 'passed';
} catch (error) { await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(join(output, 'receipt.json'), JSON.stringify({ status, checks, errors, installRequests: bodies.length, synthetic: true }, null, 2)); await browser?.close(); await host.close(); }
