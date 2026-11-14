import { seedLegacyAgentContacts } from "./legacy-agent-fixture.mjs";
import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';
// Owned synthetic Pi only. No model SDK, personal profile or third-party call.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';
const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium, _electron, expect } = requireDesktop('@playwright/test');
const native = process.argv.includes('--native');
const parent = resolve(process.env.AGENTSTUDIO_LIVE_EVIDENCE_DIR || 'output/playwright/live-conversations');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(join(parent, native ? 'native-' : 'browser-'));
const directory = join(output, 'pi-profile'), cli = join(output, 'synthetic-pi.cjs'), release = join(output, 'release'), trace = join(output, 'trace.jsonl');
await mkdir(directory);
await writeFile(cli, `#!${process.execPath}\n${await readFile(new URL('./fixtures/live-pi.cjs', import.meta.url), 'utf8')}`, { mode: 0o700 });
// Warm this fresh owned executable before the unchanged production probe budget.
const warm = spawnSync(cli, ['--version'], { timeout: 10000, stdio: 'ignore' });
if (warm.status !== 0) throw new Error('Owned synthetic Pi executable did not start');
await writeFile(join(directory, 'SYSTEM.md'), '你是合成研究伙伴。请先核对来源，再清晰回答。');
const defaults = model => writeFile(join(directory, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: model, defaultThinkingLevel: 'high', modelThinkingLevels: { 'fixture/beta': 'low' } }));
await defaults('alpha');
const env = { ...process.env, PI_CODING_AGENT_DIR: directory, AGENTSTUDIO_SYNTHETIC_RELEASE: release, AGENTSTUDIO_SYNTHETIC_TRACE: trace,
  AGENTSTUDIO_WORKSPACE: 'personal', AGENTSTUDIO_USER_DATA_DIR: join(output, 'profile'), AGENTSTUDIO_MOCK_KEYCHAIN: '1', AGENTSTUDIO_PI_BIN: cli,
  AGENTSTUDIO_CODEX_BIN: '/agentstudio-synthetic-missing-codex', AGENTSTUDIO_CLAUDE_BIN: '/agentstudio-synthetic-missing-claude',
  AGENTSTUDIO_GEMINI_BIN: '/agentstudio-synthetic-missing-gemini', AGENTSTUDIO_OPENCODE_BIN: '/agentstudio-synthetic-missing-opencode', PERSONAL_BUILD_REF: 'synthetic-live-conversations' };
  cleanDesktopTestEnv(env);
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AGENTSTUDIO_PERSONAL_DATA_DIR', 'PERSONAL_DATA_DIR']) delete env[key];
let server, browser, application, page; const checks = [], errors = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
let sequence = 0;
const request = async (path, body) => {
  const input = { path: `/api${path}`, method: body ? 'POST' : 'GET', ...(body ? { body: { ...body, clientId: `synthetic-live-${++sequence}` } } : {}) };
  if (native) return page.evaluate(async input => { const r = await window.agentStudioPersonal.request(input); if (r.status >= 400) throw new Error(JSON.stringify(r.body)); return r.body; }, input);
  const r = await fetch(`http://127.0.0.1:${server.address().port}${input.path}`, { method: input.method, headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(input.body) } : {}) });
  const result = await r.json(); if (!r.ok) throw new Error(JSON.stringify(result)); return result;
};
const waitThread = async (id, predicate) => { let value; await expect.poll(async () => { value = await request(`/threads/${id}`); return predicate(value); }, { timeout: 20000 }).toBe(true); return value; };
const send = async text => { await page.getByTestId('im-message-input').fill(text); await page.getByTestId('im-send').click(); };
const capture = name => page.screenshot({ path: join(output, `${name}.png`) });
seedLegacyAgentContacts(native ? join(output, "profile", "personal") : join(output, "data"), { onboardingCompleted: false });
try {
  if (native) {
    const packaged = process.env.AGENTSTUDIO_PACKAGED_APP;
    application = await launchDesktopTest(_electron, { executablePath: packaged ? join(packaged, 'Contents/MacOS/AgentRoom') : requireDesktop('electron'), args: packaged ? [] : [resolve('apps/desktop')], env, timeout: 30000 });
    await expect.poll(() => application.windows().filter(w => w.url().startsWith('file:')).length).toBe(1);
    page = application.windows().find(w => w.url().startsWith('file:'));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:')).setBounds({ width: 1200, height: 800 }));
  } else {
    server = await createPersonalServer({ port: 0, dataDir: join(output, 'data'), staticDir: resolve('apps/personal/dist'), codexCommand: env.AGENTSTUDIO_CODEX_BIN,
      localAgentDeps: { env, commands: { pi: cli, codex: env.AGENTSTUDIO_CODEX_BIN, claude: env.AGENTSTUDIO_CLAUDE_BIN, gemini: env.AGENTSTUDIO_GEMINI_BIN, opencode: env.AGENTSTUDIO_OPENCODE_BIN } } });
    await server.listen(); browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
    page = await browser.newPage({ viewport: { width: 1320, height: 860 } }); await page.goto(`http://127.0.0.1:${server.address().port}`);
  }
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByTestId('workspace-guide')).toBeVisible({ timeout: 20000 });
  expect((await request('/bootstrap')).workspace.guide.agentId).toBe('pi');
  await page.getByTestId('im-nav-contacts').click(); await page.getByTestId('im-new').click();
  await page.getByTestId('im-local-customize').click();
  await page.getByTestId('im-contact-advanced').click();
  await expect(page.getByTestId('im-detected-model')).toHaveText('alpha');
  await page.getByTestId('im-contact-name').fill('研究伙伴'); await page.getByTestId('im-contact-handle').fill('research');
  await page.getByTestId('im-extract-identity').click();
  await expect(page.getByTestId('im-contact-instructions')).toHaveValue('你是合成研究伙伴。请先核对来源，再清晰回答。');
  await page.getByTestId('im-contact-appearance').click();
  await page.getByTestId('im-avatar-mode-provider').click();
  await page.getByTestId('im-avatar-icon-research').click(); await capture('identity-and-model');
  await page.getByTestId('im-contact-save').click(); await expect(page.getByTestId('im-contact-detail')).toContainText('alpha');
  const contact = (await request('/contacts')).contacts.find(c => c.handle === 'research');
  expect(contact.icon).toBe('research'); expect(contact.instructions).toContain('合成研究伙伴');
  check('create contact detects the saved Pi model and previews explicit identity extraction');
  await page.getByTestId('im-start-chat').click(); await expect(page.getByTestId('im-message-input')).toBeVisible(); const id = new URL(page.url()).searchParams.get('thread');
  await send('第一问 FIRST：帮我整理这段想法。');
  await expect(page.getByTestId('im-streaming-message')).toContainText('第一段', { timeout: 15000 });
  expect((await request(`/threads/${id}`)).artifacts).toHaveLength(0);
  await page.getByTestId('im-message-input').fill('第二问 SECOND：也考虑一下排队。'); await expect(page.getByTestId('im-send')).toBeEnabled();
  await page.getByTestId('im-send').click();
  await expect(page.getByTestId('im-run-status')).toHaveCount(2); await expect(page.getByTestId('im-timeline')).toContainText('等待助手处理');
  await capture('live-follow-up');
  check('partial reply is real text, send stays available and the follow-up has its own queued slot');
  await defaults('beta');
  await expect.poll(async () => (await request('/contacts')).contacts.find(c => c.id === contact.id)?.execution?.model, { timeout: 15000 }).toBe('beta');
  await expect(page.getByTestId('im-chat-info')).not.toContainText('beta');
  await send('第三问 THIRD：新的默认模型。');
  const accepted = await waitThread(id, t => t.runs.length === 3);
  expect(accepted.runs.map(r => r.executionSnapshot.model)).toEqual(['alpha', 'alpha', 'beta']);
  expect(accepted.runs[2].executionSnapshot.thinking).toBe('low');
  check('saved Pi changes appear without restart and only new sends use the changed model');
  await writeFile(release, 'release'); await waitThread(id, t => t.runs.every(r => r.status === 'completed'));
  await expect(page.getByTestId('im-streaming-message')).toHaveCount(0);
  await expect(page.getByTestId('im-message')).toHaveCount(6);
  const order = await page.getByTestId('im-timeline').evaluate(node => [...node.querySelectorAll('[data-testid="im-message"]')].map(n => n.textContent));
  expect(order[0]).toContain('第一问'); expect(order[1]).toContain('FIRST_REPLY'); expect(order[2]).toContain('第二问'); expect(order[3]).toContain('SECOND_REPLY');
  const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  expect(calls[1].context.messages.some(m => m.role === 'assistant' && m.text.includes('FIRST_REPLY'))).toBe(true);
  expect(JSON.stringify(calls[1].context)).not.toContain('第三问');
  const markdown = await page.getByTestId('im-timeline').evaluate(node => ({ heading: !!node.querySelector('h2'), code: !!node.querySelector('pre code'), table: !!node.querySelector('table') }));
  expect(markdown).toEqual({ heading: true, code: true, table: true }); await capture('completed-markdown');
  check('replies replace their original slots, include the late prior answer and render Markdown');
  await page.getByTestId('im-chat-info').click(); await page.getByTestId('im-agent-basic').click();
  await page.getByTestId('im-contact-advanced').click();
  await page.getByTestId('im-model-options-toggle').click();
  await page.getByTestId('im-model-policy').selectOption('fixed');
  await page.getByTestId('im-model-select').selectOption(JSON.stringify(['fixture', 'alpha']));
  await page.getByTestId('im-model-thinking').selectOption('medium');
  expect(await page.getByTestId('im-model-thinking').evaluate(node => [...node.options].map(option => option.value))).not.toContain('max');
  await page.getByTestId('im-contact-save').click(); await expect(page.getByTestId('im-agent-basic')).toContainText('alpha');
  await page.getByTestId('personal-modal-close').click();
  await page.reload(); await expect(page.getByTestId('im-chat-info')).not.toContainText('alpha');
  await send('第四问 FIXED：联系人独立模型。');
  await waitThread(id, t => t.runs[3]?.status === 'completed');
  const fixed = (await request(`/threads/${id}`)).runs[3].executionSnapshot;
  expect([fixed.model, fixed.thinking]).toEqual(['alpha', 'medium']);
  check('contact model and supported effort override survive reload and apply to subsequent sends');
  await rm(release); await send('第五问 FIRST：继续整理想法。');
  await expect(page.getByTestId('im-streaming-message')).toBeVisible();
  await send('stop'); await send('先停一下');
  const pending = await waitThread(id, t => t.runs.length === 7);
  expect(pending.runs.slice(4).map(run => run.status)).toEqual(['running', 'queued', 'queued']);
  expect(pending.runs.slice(4).every(run => run.contactId === contact.id)).toBe(true);
  await expect(page.getByTestId(/^im-run-stop-/)).toHaveCount(0);
  await page.getByTestId('im-results').click();
  await expect(page.getByTestId('im-conversation-details')).toBeVisible();
  await expect(page.getByTestId('im-conversation-details')).not.toContainText('停止这次执行');
  await page.getByTestId('personal-modal-close').click(); await capture('stop-as-message');
  await writeFile(release, 'release'); await waitThread(id, t => t.runs.every(run => run.status === 'completed'));
  const stopCalls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse).slice(-2);
  expect(stopCalls.map(call => call.request)).toEqual(['stop', '先停一下']);
  expect(stopCalls.every(call => call.context.agentIdentity.id === contact.id)).toBe(true);
  check('chat has no stop controls and ordinary stop messages reach the chosen CLI in order without cancelling work');
  await send('第八问 FAIL_ZERO：模拟失败。'); await waitThread(id, t => t.runs[7]?.status === 'blocked');
  expect((await request(`/threads/${id}`)).artifacts).toHaveLength(7);
  await expect(page.getByTestId(`im-response-${(await request(`/threads/${id}`)).runs[7].id}`)).toContainText('未完成的回复');
  expect(await page.getByTestId('im-timeline').textContent()).not.toContain('SYNTHETIC_PRIVATE_THINKING');
  check('failed structured result stays incomplete and private reasoning never enters the UI');
  if (!native) {
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' }); await capture('dark-live-chat');
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await expect(page.getByTestId('im-message-input')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await capture('narrow-live-chat');
    check('dark mode, reduced motion and narrow chat keep controls and Markdown within the window');
  } else {
    expect(page.url().startsWith('file:')).toBe(true); const health = await request('/health'); expect(health.build.serverFiles['creation-service.mjs']).toBeTruthy(); expect(health.build.serverFiles['agentroom-tool-proxy.mjs']).toBeTruthy();
    check('actual Electron runs the bundled eight-module backend through fixed IPC');
  }
  expect(errors).toEqual([]); check('no renderer exceptions');
} catch (error) { await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); throw error; }
finally {
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ synthetic: true, native, checks, errors, output }, null, 2));
  await application?.close(); await browser?.close(); await server?.close(); console.log(JSON.stringify({ output, passed: checks.length, synthetic: true }));
}
