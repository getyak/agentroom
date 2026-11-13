// Isolated synthetic contacts; no provider account or model is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium } = createRequire(require.resolve('@playwright/test'))('playwright');
const { expect } = require('@playwright/test');
const parent = resolve(process.env.AGENTROOM_CONTACT_NAMES_EVIDENCE_DIR || 'output/playwright/contact-names');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(join(parent, 'browser-'));
const title = '# CanvasDesk · A service for rendering pages, posts and profile cards';
const source = 'Please analyze why a synthetic participant 2026/08/27 00:26 can renew later';
const app = await createPersonalServer({ dataDir: join(output, 'data'), port: 0,
  staticDir: resolve(process.env.AGENTROOM_CONTACT_NAMES_STATIC_DIR || 'apps/personal/dist'), discoverLocalAgents: async () => ({ agents: [] }) });
let browser;
const checks = [], errors = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
try {
  for (const [id, name] of [['canvas', title], ['fragment', source], ['custom', title]]) app.store.put('connection', {
    id: `con_${id}`, name, type: 'a2a', url: `http://127.0.0.1:1/a2a/${id}`,
  });
  app.store.put('contact', { id: 'connection_con_custom', kind: 'agent', name: 'My custom research partner', handle: 'custom', version: 2,
    discovered: true, providerName: title, binding: { type: 'connection', connectionId: 'con_custom' }, color: 'blue', instructions: '', description: '' });
  await app.listen();
  const origin = `http://127.0.0.1:${app.address().port}`;
  const api = async path => { const r = await fetch(`${origin}/api${path}`); assert.equal(r.ok, true); return r.json(); };
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByTestId('workspace-owner-name').fill('Synthetic contact QA');
  await page.getByTestId('workspace-guide-finish').click();
  await page.getByTestId('im-nav-contacts').click();
  const canvas = page.getByTestId('im-contact-connection_con_canvas');
  await expect(canvas).toContainText('CanvasDesk');
  await expect(canvas).toHaveAttribute('title', title);
  await expect(page.getByTestId('im-contact-connection_con_fragment')).toContainText('个人助手 · agment');
  await expect(page.getByTestId('im-contact-connection_con_custom')).toContainText('My custom research partner');
  await page.getByTestId('im-search').fill('profile cards');
  await expect(canvas).toBeVisible();
  await canvas.click();
  await page.getByTestId('im-contact-source-name').click();
  await expect(page.getByTestId('im-contact-source-name')).toContainText(title);
  check('short headings and stable fallbacks preserve custom names and full-source search');
  await page.screenshot({ path: join(output, 'desktop.png') });

  await page.getByTestId('im-edit-contact').click();
  await page.getByTestId('im-contact-name').fill('My visual partner');
  await page.getByTestId('im-contact-save').click();
  await expect(page.getByTestId('im-contact-detail')).toContainText('My visual partner');
  await page.reload();
  await page.getByTestId('im-nav-contacts').click();
  await canvas.click();
  await expect(page.getByTestId('im-contact-detail')).toContainText('My visual partner');
  const contact = (await api('/contacts')).contacts.find(c => c.id === 'connection_con_canvas');
  assert.equal(contact.nameSource, 'custom'); assert.equal(contact.sourceName, title);
  await page.getByTestId('im-edit-contact').click();
  await page.getByTestId('im-contact-name-source').click();
  await page.getByTestId('im-contact-name-suggestion').click();
  await expect(page.getByTestId('im-contact-name')).toHaveValue('CanvasDesk');
  await page.getByTestId('im-contact-save').click();
  check('chosen display names survive reload and suggested names require an explicit save');

  await page.getByTestId('im-start-chat').click();
  await expect(page.getByTestId('im-chat-info')).toContainText('CanvasDesk');
  const threadId = new URL(page.url()).searchParams.get('thread');
  assert.ok(threadId);
  await page.getByTestId('im-search').fill('profile cards');
  await expect(page.getByTestId(`im-chat-${threadId}`)).toBeVisible();
  check('private conversations remain searchable by full provider names');

  await page.getByTestId('im-nav-contacts').click();
  await page.getByTestId('im-search').fill('');
  await page.setViewportSize({ width: 560, height: 820 });
  await expect(canvas).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, 'narrow.png') });
  await canvas.click();
  await page.getByTestId('im-contact-source-name').click();
  await expect(page.getByTestId('im-contact-source-name')).toContainText(title);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('narrow contact lists and full-name details fit without horizontal overflow');
  const health = await api('/health');
  assert.match(health.build.serverFiles['contact-names.mjs'], /^[a-f0-9]{64}$/);
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ synthetic: true, checks, errors }, null, 2));
  console.log(`Evidence: ${output}`);
} finally { await browser?.close(); await app.close(); }
