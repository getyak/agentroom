import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';
// Isolated history/messenger convergence. Only local synthetic data is sent.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';
const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium, _electron } = createRequire(requireDesktop.resolve('@playwright/test'))('playwright');
const { expect } = requireDesktop('@playwright/test');
const native = process.argv.includes('--native');
const parent = resolve(process.env.AGENTSTUDIO_CONVERSATION_EVIDENCE_DIR || 'output/playwright/conversations');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(join(parent, native ? 'native-' : 'browser-'));
let server, browser, application, page;
const checks = [], errors = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const request = async (path, body) => {
  if (native) return page.evaluate(async ({ path, body }) => {
    const result = await window.agentStudioPersonal.request({ path: `/api${path}`, method: body ? 'POST' : 'GET', ...(body ? { body } : {}) });
    if (result.status >= 400) throw new Error(`HTTP ${result.status}`);
    return result.body;
  }, { path, body });
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const waitThread = async (id, predicate) => {
  let thread;
  await expect.poll(async () => { thread = await request(`/threads/${id}`); return predicate(thread); }, { timeout: 20000 }).toBe(true);
  return thread;
};
const seedDraft = async (id, value) => page.evaluate(({ id, value }) => localStorage.setItem(`agentstudio.personal.draft.${id}`, JSON.stringify(value)), { id, value });
const open = async (id, old = false) => {
  const url = new URL(page.url()); url.search = `${old ? '?workspace=tasks&' : '?'}thread=${id}`;
  await page.goto(url.href);
};
try {
  if (native) {
    const env = { ...process.env, AGENTSTUDIO_PI_BIN: '/agentstudio-synthetic-missing-pi', AGENTSTUDIO_CLAUDE_BIN: '/agentstudio-synthetic-missing-claude', AGENTSTUDIO_WORKSPACE: 'personal', AGENTSTUDIO_MOCK_KEYCHAIN: '1', AGENTSTUDIO_USER_DATA_DIR: join(output, 'profile'), AGENTSTUDIO_CODEX_BIN: 'agentstudio-intentionally-missing-test-cli' };
    cleanDesktopTestEnv(env);
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AGENTSTUDIO_PERSONAL_DATA_DIR', 'PERSONAL_DATA_DIR']) delete env[key];
    const packaged = process.env.AGENTSTUDIO_PACKAGED_APP;
    application = await launchDesktopTest(_electron, { executablePath: packaged ? join(packaged, 'Contents/MacOS/AgentRoom') : requireDesktop('electron'), args: packaged ? [] : [resolve('apps/desktop')], env, timeout: 30000 });
    page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1200, height: 780 }));
  } else {
    server = await createPersonalServer({ dataDir: join(output, 'data'), port: 0, codexCommand: 'agentstudio-intentionally-missing-test-cli', staticDir: resolve('apps/personal/dist') });
    await server.listen();
    browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
    page = await (await browser.newContext({ acceptDownloads: true, viewport: { width: 1320, height: 860 } })).newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
  }
  page.on('pageerror', e => errors.push(e.message));
  const first = await request('/threads', { text: '合成历史对话：保留原始记录。', mode: 'local', attachments: [], memoryIds: [], clientId: 'history-initial' });
  await waitThread(first.id, t => t.status === 'completed');
  const original = { text: '已接受但回包丢失的合成请求', attachments: [{ name: 'original.md', text: '# 合成原文\n\n保留这份资料。', size: 36 }], mode: 'local', connectionId: '' };
  const originalBody = { text: original.text, clientId: 'history-lost-response', attachments: original.attachments.map(({ name, text }) => ({ name, text })), mode: 'local', connectionId: undefined, memoryIds: [] };
  await request(`/threads/${first.id}/messages`, originalBody);
  await waitThread(first.id, t => t.status === 'completed' && t.runs.length === 2);
  await seedDraft(first.id, { ...original, text: '后来补写、尚未发送的中文草稿', attachments: [], requestId: originalBody.clientId, signature: JSON.stringify(original), memoryIds: [] });
  await open(first.id, true);
  await expect(page.getByTestId('im-app')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('im-message-input')).toHaveValue('后来补写、尚未发送的中文草稿');
  await expect(page.getByTestId('im-legacy-workspace')).toHaveCount(0);
  await expect(page.getByTestId('im-task-mode')).toHaveValue('local');
  check('old workspace URL and historical thread use the single messenger with the original draft');
  await page.getByTestId('im-send').click();
  await expect(page.getByTestId('im-send-recovery')).toHaveCount(0);
  expect((await request(`/threads/${first.id}`)).runs.length).toBe(2);
  await expect(page.getByTestId('im-message-input')).toHaveValue('后来补写、尚未发送的中文草稿');
  check('lost response retries the original fingerprint once and preserves later unsent edits');
  await page.getByTestId('im-send').click();
  await waitThread(first.id, t => t.status === 'completed' && t.runs.length === 3);
  await expect(page.getByTestId('im-message-input')).toHaveValue('');
  await expect(page.getByTestId('im-task-mode')).toHaveValue('local');
  await page.reload();
  await expect(page.getByTestId('im-message-input')).toHaveValue('');
  check('history continues in the same thread and a sent legacy draft never reappears');
  await page.getByTestId('im-attach').setInputFiles({ name: 'synthetic.ts', mimeType: 'text/plain', buffer: Buffer.from('export const synthetic = true;') });
  await page.getByTestId('im-message-input').fill('整理这份合成代码资料');
  await page.getByTestId('im-send').click();
  await waitThread(first.id, t => t.status === 'completed' && t.runs.length === 4);
  await page.getByTestId('im-results').click();
  await expect(page.getByTestId('im-conversation-details')).toBeVisible();
  await expect(page.getByTestId('im-artifact')).toHaveCount(4);
  await expect(page.getByTestId('im-execution-record')).toHaveCount(4);
  await page.screenshot({ path: join(output, 'conversation-details.png') });
  await page.getByTestId('im-artifact').last().click();
  await expect(page.getByTestId('personal-reader')).toContainText('synthetic.ts');
  await expect(page.getByTestId('personal-reader-download')).toBeVisible();
  await page.getByTestId('personal-modal-close').last().click();
  await page.getByTestId('personal-modal-close').click();
  check('all original result versions, code sources and execution records stay accessible in chat');
  const scratch = { text: '合成未建会话草稿', mode: 'local', connectionId: '', attachments: [] };
  const accepted = await request('/threads', { text: scratch.text, clientId: 'scratch-lost-response', attachments: [], mode: 'local', memoryIds: [] });
  await waitThread(accepted.id, t => t.status === 'completed');
  await seedDraft('new', { ...scratch, requestId: 'scratch-lost-response', signature: JSON.stringify(scratch), memoryIds: [] });
  // Old signature order was text,attachments,mode,connectionId.
  await seedDraft('new', { ...scratch, signature: JSON.stringify({ text: scratch.text, attachments: [], mode: 'local', connectionId: '' }), requestId: 'scratch-lost-response', memoryIds: [] });
  await open('new', true);
  await expect(page.getByTestId('im-message-input')).toHaveValue(scratch.text);
  await page.getByTestId('im-send').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('thread')).toBe(accepted.id);
  const workspace = await request('/bootstrap');
  expect(workspace.threads.filter(thread => thread.id !== workspace.workspace?.guide?.threadId).length).toBe(2);
  check('unconfirmed draft.new resumes the original creation without a duplicate conversation');
  await page.evaluate(({ acceptedId, scratch }) => {
    localStorage.removeItem('agentstudio.messenger.draft.new');
    localStorage.setItem(`agentstudio.messenger.draft.${acceptedId}`, JSON.stringify({ text: '已建会话中较新的草稿', attachments: [], revision: 5, mode: 'local' }));
    localStorage.setItem('agentstudio.personal.draft.new', JSON.stringify({ ...scratch, requestId: 'scratch-lost-response', signature: JSON.stringify({ text: scratch.text, attachments: [], mode: 'local', connectionId: '' }), memoryIds: [] }));
  }, { acceptedId: accepted.id, scratch });
  await open('new', true); await page.getByTestId('im-send').click();
  await expect(page.getByTestId('im-message-input')).toHaveValue('已建会话中较新的草稿');
  await page.reload(); await expect(page.getByTestId('im-message-input')).toHaveValue('已建会话中较新的草稿');
  check('recovering a creation receipt never replaces a newer destination draft');
  if (!native) {
    await page.getByTestId('im-new').click(); await page.getByTestId('im-new-notes').click();
    let release, reached, created;
    const captured = new Promise(r => { reached = r; });
    await page.route('**/api/threads', async route => {
      const response = await route.fetch(); created = await response.json(); reached();
      await new Promise(r => { release = r; }); await route.fulfill({ response });
    });
    await page.getByTestId('im-message-input').fill('合成迟到回包：创建一段新对话');
    await page.getByTestId('im-send').click(); await captured;
    await page.getByTestId(`im-chat-${created.id}`).click();
    await page.getByTestId('im-message-input').fill('先打开新会话后补写的草稿');
    release();
    await expect(page.getByTestId('im-send')).toBeEnabled();
    await expect(page.getByTestId('im-message-input')).toHaveValue('先打开新会话后补写的草稿');
    await page.reload(); await expect(page.getByTestId('im-message-input')).toHaveValue('先打开新会话后补写的草稿');
    await page.unroute('**/api/threads');
    check('late creation response preserves edits made after opening the new conversation');
  }
  await page.getByTestId('im-settings').click();
  await expect(page.getByTestId('im-app')).toBeVisible();
  await page.getByTestId('personal-tab-memory').click();
  await page.getByTestId('personal-memory-input').fill('合成偏好：结果保留来源');
  await page.getByTestId('personal-memory-save').click();
  await expect(page.getByTestId('personal-modal')).toContainText('合成偏好：结果保留来源');
  await page.screenshot({ path: join(output, 'settings.png') });
  await page.getByTestId('personal-modal-close').click();
  check('settings and memory open and close inside the same messenger');
  if (!native) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.getByTestId('im-results').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(output, 'narrow-dark-details.png') });
    await page.getByTestId('personal-modal-close').click();
    await expect(page.getByTestId('im-message-input')).toBeVisible();
    check('narrow dark history keeps tools in the same shell without overflow');
  }
  expect(errors).toEqual([]);
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ synthetic: true, native, checks, errors }, null, 2));
  console.log(JSON.stringify({ output, checks: checks.length }));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  console.error(error.stack); process.exitCode = 1;
} finally {
  await application?.close().catch(() => {}); await browser?.close(); await server?.close();
}
