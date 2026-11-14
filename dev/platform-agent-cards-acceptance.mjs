// Isolated service metadata; no model calls or private accounts.
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';
import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium, _electron } = createRequire(require.resolve('@playwright/test'))('playwright');
const { expect } = require('@playwright/test');
const output = resolve(process.env.AGENTROOM_CARDS_EVIDENCE_DIR || 'output/playwright/platform-agent-cards');
await mkdir(output, { recursive: true });
const state = await mkdtemp(join(output, 'isolated-'));
const native = process.argv.includes('--native');
let application, nativePage;
let model = 'synthetic-remote-model';
const profile = () => ({ agentId: 'codex', defaults: { provider: 'openai', model, thinking: 'high' }, models: [], providers: ['openai'], thinkingLevels: ['high'], version: model });
const host = await createPersonalServer({ dataDir: join(state, 'host'), port: 0, nodePollMs: 0, codexCommand: '/missing-synthetic',
  discoverLocalAgents: async () => ({ checkedAt: new Date().toISOString(), agents: [{ id: 'codex', name: 'Codex', installed: true, auth: { status: 'configured' }, execution: { supported: true }, profile: profile(),
    quota: { status: 'available', checkedAt: new Date().toISOString(), windows: [{ remainingPercent: 72.5, windowMinutes: 300, resetsAt: '2026-11-15T08:00:00Z' }, { remainingPercent: 0, windowMinutes: 10080 }], credits: { balance: '12.50', unlimited: false } } }] }),
  sharingAddresses: () => ['127.0.0.1'], sharingPort: 0 });
const peer = await createPersonalServer({ dataDir: join(state, 'peer'), port: 0, staticDir: resolve('apps/personal/dist'), nodePollMs: 0, remotePollMs: 0, codexCommand: '/missing-synthetic', discoverLocalAgents: async () => ({ agents: [] }) });
const api = async (app, path, body) => {
  if (app === peer && nativePage) {
    const result = await nativePage.evaluate(async ({ path, body }) => window.agentStudioPersonal.request({ path: `/api${path}`, method: body ? 'POST' : 'GET', ...(body ? { body } : {}) }), { path, body });
    if (result.status >= 400) throw new Error(result.body.error?.message); return result.body;
  }
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message); return result;
};
let browser;
const errors = [];
try {
  await host.listen(); await peer.listen();
  if (native) {
    const env = { ...process.env, AGENTSTUDIO_USER_DATA_DIR: join(state, 'native'), AGENTSTUDIO_WORKSPACE: 'personal', AGENTSTUDIO_MOCK_KEYCHAIN: '1' };
    cleanDesktopTestEnv(env);
    for (const id of ['CODEX', 'CLAUDE', 'PI', 'GEMINI', 'OPENCODE']) env[`AGENTSTUDIO_${id}_BIN`] = '/missing-synthetic';
    application = await launchDesktopTest(_electron, { executablePath: require('electron'), args: [resolve('apps/desktop')], env });
    nativePage = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 900 }));
  }
  await api(host, '/contacts/local', { agentIds: ['codex'], clientId: 'adopt-synthetic' });
  await api(host, '/sharing', { enabled: true, host: '127.0.0.1', name: 'MacBook 测试设备', contactIds: ['agent_codex'] });
  const added = await api(peer, '/nodes/connect', await api(host, '/sharing/invite', {}));
  await api(peer, '/workspace/onboarding', { action: 'complete', name: '名片测试', clientId: 'complete-synthetic' });
  if (!native) browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
  const page = nativePage || await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  if (!native) await page.goto(`http://127.0.0.1:${peer.address().port}`); else await page.reload();
  const open = async () => { await page.getByTestId('im-nav-contacts').click(); await page.getByTestId(`im-contact-connection_${added.connections[0].id}`).click(); };
  await open();
  await expect(page.getByTestId('im-agent-card-model')).toHaveText(model);
  await expect(page.getByTestId('im-agent-card-thinking')).toHaveText('high');
  await expect(page.getByTestId('im-agent-card-quota')).toContainText('5 小时剩余 72.5%');
  await expect(page.getByTestId('im-agent-card-quota')).toContainText('7 天剩余 0%');
  await expect(page.getByTestId('im-agent-card-quota')).toContainText('余额 12.50 credits');
  await page.screenshot({ path: join(output, 'remote-card-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('im-agent-card')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(output, 'remote-card-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  model = 'updated-remote-model'; await page.getByTestId('im-agent-card-refresh').click();
  await expect(page.getByTestId('im-agent-card-model')).toHaveText(model);
  await page.reload(); await open();
  await expect(page.getByTestId('im-agent-card-model')).toHaveText(model);
  if (!native) {
  let releaseOld, receivedOld;
  const oldReady = new Promise(resolve => { receivedOld = resolve; });
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  await page.route('**/api/contacts/*/info', async route => {
    const response = await route.fetch(); receivedOld(); await oldGate; await route.fulfill({ response });
  }, { times: 1 });
  await page.getByTestId('im-agent-card-refresh').click(); await oldReady;
  model = 'newer-source-model'; await api(peer, `/nodes/${added.node.id}/check`, {});
  await expect(page.getByTestId('im-agent-card-model')).toHaveText(model);
  const oldDelivered = page.waitForResponse(response => response.url().endsWith('/info'));
  releaseOld(); await (await oldDelivered).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByTestId('im-agent-card-refresh')).toBeEnabled();
  await expect(page.getByTestId('im-agent-card-model')).toHaveText(model);
  }
  await api(host, '/sharing', { enabled: false });
  try { await api(peer, `/nodes/${added.node.id}/check`, {}); } catch { /* Keep the failed observation. */ }
  await page.reload(); await open();
  await expect(page.getByTestId('im-agent-card-source')).toContainText('上次读取');
  await expect(page.getByTestId('im-agent-card-model')).toHaveText(model);
  expect(errors).toEqual([]);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, scope: native ? 'hidden Electron IPC with synthetic source device' : 'synthetic two-instance HTTP/browser metadata', checks: ['model and thinking', 'window percentage including zero', 'credits and reset', '390px layout', 'source update', ...(!native ? ['late refresh cannot overwrite newer configuration'] : []), 'offline retained timestamp'], errors }, null, 2));
  console.log(JSON.stringify({ passed: true, output }));
} finally { await browser?.close(); await application?.close(); await peer.close(); await host.close(); await rm(state, { recursive: true, force: true }); }
