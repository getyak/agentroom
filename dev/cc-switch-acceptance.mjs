// Synthetic configuration only. No model calls or real CC Switch database access.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium } = createRequire(require.resolve('@playwright/test'))('playwright');
const { expect } = require('@playwright/test');
const output = resolve(process.env.AGENTROOM_EVIDENCE_DIR || 'output/playwright/cc-switch');
await mkdir(output, { recursive: true });
const state = await mkdtemp(join(output, 'synthetic-'));
let status = 'available', count = 1;
const inventory = () => ({ status, profiles: status === 'available' ? 1 : null, clients: status === 'available' ? [
  { id: 'codex', name: 'Codex', providers: { total: 3, selected: 1 }, mcp: { enabled: count, names: ['Synthetic MCP'], truncated: false }, skills: { enabled: 1, names: ['Synthetic-skill-' + 'x'.repeat(80)], truncated: false }, prompts: 1 },
  { id: 'pi', name: 'Pi', providers: { total: 0, selected: 0 }, mcp: null, skills: null, prompts: 0 },
] : [] });
const server = await createPersonalServer({ dataDir: join(state, 'data'), port: 0, staticDir: resolve('apps/personal/dist'),
  codexCommand: '/missing-synthetic', discoverLocalAgents: async () => ({ agents: [] }), discoverCcSwitch: async () => inventory() });
let browser;
const errors = [], checks = [];
try {
  await server.listen();
  await fetch(`http://127.0.0.1:${server.address().port}/api/workspace/onboarding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'complete', clientId: 'cc-switch-acceptance' }) });
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (event.type() === 'error') errors.push(event.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByTestId('im-settings').click(); await page.getByTestId('personal-tab-connections').click();
  const panel = page.getByTestId('personal-cc-switch');
  await expect(panel).toBeVisible();
  assert.equal(await panel.getAttribute('open'), null);
  await panel.locator(':scope > summary').click();
  await expect(page.getByTestId('personal-cc-switch-codex')).toContainText('供应商 3');
  await expect(page.getByTestId('personal-cc-switch-pi')).toContainText('MCP 未识别');
  const extensions = page.getByTestId('personal-cc-switch-codex').locator('details');
  await extensions.nth(0).locator('summary').click();
  await extensions.nth(1).locator('summary').click();
  await expect(panel).toContainText('Synthetic MCP');
  await page.screenshot({ path: join(output, 'desktop.png') });
  checks.push('collapsed metadata inventory, expandable extension names and unknown schema values');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, 'narrow.png') });
  checks.push('390px layout with long skill name has no horizontal overflow');
  count = 2;
  await page.getByTestId('personal-integrations-refresh').click();
  await expect(page.getByTestId('personal-cc-switch-codex')).toContainText('MCP 2');
  status = 'unavailable'; await page.getByTestId('personal-integrations-refresh').click();
  await expect(page.getByTestId('personal-cc-switch-unavailable')).toBeVisible();
  status = 'not_found'; await page.getByTestId('personal-integrations-refresh').click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('personal-cc-switch-unavailable')).toHaveCount(0);
  status = 'available'; await page.getByTestId('personal-integrations-refresh').click();
  await expect(panel).toBeVisible();
  checks.push('refresh updates values, read failure recovers and missing source stays unobtrusive');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'report.json'), JSON.stringify({ source: 'synthetic', checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors, output }, null, 2));
} finally { await browser?.close(); await server.close(); await rm(state, { recursive: true, force: true }); }
