import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';
// Native synthetic acceptance only: reuse the already-running e2e/fakes/agents.ts
// on 127.0.0.1:19179. Never start/reset that server or use real service accounts.
// Run after building: AGENTSTUDIO_DESKTOP_EVIDENCE_DIR=<registered artifact> \
//   node dev/personal-connect-synthetic.mjs --synthetic
// Optional: AGENTSTUDIO_PACKAGED_APP=/absolute/AgentRoom.app
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

if (!process.argv.includes('--synthetic')) throw new Error('Pass --synthetic to launch one isolated test app against the local fake services.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const { _electron, expect } = requireDesktop('@playwright/test');
const fakeOrigin = 'http://127.0.0.1:19179';
const parent = resolve(process.env.AGENTSTUDIO_DESKTOP_EVIDENCE_DIR || join(root, 'output/playwright/connect-synthetic'));
await mkdir(parent, { recursive: true });
const evidence = await mkdtemp(join(parent, 'synthetic-'));
const profile = join(evidence, 'profile');
const marker = `SYNTHETIC_NATIVE_${randomUUID().replaceAll('-', '')}`;
const taskText = `合成验收 / Synthetic check：请原样回应标记 ${marker}，再保留这句中文与 English 混排。仅使用这次输入，不做任何其他操作。`;
const packagedApp = process.env.AGENTSTUDIO_PACKAGED_APP ? resolve(process.env.AGENTSTUDIO_PACKAGED_APP) : null;
let executablePath;
if (packagedApp) {
  if (!packagedApp.endsWith('.app')) throw new Error('AGENTSTUDIO_PACKAGED_APP must name an explicit .app bundle.');
  executablePath = join(packagedApp, 'Contents/MacOS/AgentRoom');
} else {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const mainRequire = createRequire(join(dirname(common), 'apps/desktop/package.json'));
  executablePath = process.env.AGENTSTUDIO_ELECTRON_BINARY || mainRequire('electron');
}
await stat(executablePath);
const env = {
  ...process.env,
  AGENTSTUDIO_USER_DATA_DIR: profile,
  AGENTSTUDIO_PERSONAL_EXPORT_DIR: join(evidence, 'exports'),
  AGENTSTUDIO_PI_BIN: '/agentstudio-synthetic-missing-pi', AGENTSTUDIO_CLAUDE_BIN: '/agentstudio-synthetic-missing-claude', AGENTSTUDIO_MOCK_KEYCHAIN: '1',
  AGENTSTUDIO_CODEX_BIN: join(evidence, 'missing-model-executor'),
  AGENTSTUDIO_CONNECTOR_PORT: '0',
  AGENTSTUDIO_CONNECTOR_OPEN_IN_WINDOW: '1',
  AGENTSTUDIO_GROKBOT_API_URL: `${fakeOrigin}/grok/api`,
  AGENTSTUDIO_GROKBOT_WEB_URL: `${fakeOrigin}/grok/web`,
  AGENTSTUDIO_GROKBOT_POLL_MS: '300',
  AGENTSTUDIO_GROKBOT_APP: join(evidence, 'missing-grok.app'),
  AGENTSTUDIO_CUE_API_URL: `${fakeOrigin}/cue`,
  AGENTSTUDIO_CUE_WEB_URL: `${fakeOrigin}/cue-web`,
  AGENTSTUDIO_CUE_RPC_URL: `${fakeOrigin}/cue-rpc`,
  AGENTSTUDIO_CUE_POLL_MS: '300',
  AGENTSTUDIO_MUSE_URL: `${fakeOrigin}/muse/`,
  AGENTSTUDIO_DOTS_URL: `${fakeOrigin}/dots/`,
  NO_PROXY: [process.env.NO_PROXY, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(','),
};
cleanDesktopTestEnv(env);
for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AGENTSTUDIO_WORKSPACE', 'AGENTSTUDIO_PERSONAL_DATA_DIR', 'AGENTSTUDIO_CONNECTOR_TRACE', 'AGENTSTUDIO_CONNECTOR_TRACE_NETWORK', 'AGENTSTUDIO_CONNECTOR_TRACE_BODIES', 'AGENTSTUDIO_CONNECTOR_SHOW']) delete env[name];
const checks = [], errors = [], captures = [], publicSamples = [], connectedServices = [];
let application, page, phase = 'preflight';
const verify = (value, name) => { if (!value) throw new Error(name); if (!checks.includes(name)) { checks.push(name); console.log(`PASS ${name}`); } };
const publicShapeSafe = value => {
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, item]) => !['token', 'url', 'cookie', 'cookies', 'authorization', 'accessToken', 'refreshToken', 'credentialRef'].includes(key) && publicShapeSafe(item));
};
const native = async input => {
  const reply = await page.evaluate(input => window.agentStudioPersonal.nativeIntegration(input), input);
  verify(publicShapeSafe(reply), `public ${input.kind} response contains no endpoint or credential fields`);
  publicSamples.push(reply);
  if (reply.state === 'failed') throw new Error(`Native ${input.kind} reported a failed connection`);
  return reply;
};
const api = (path, body) => page.evaluate(async ({ path, body }) => {
  const response = await window.agentStudioPersonal.request({ path: `/api${path}`, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body }) });
  if (response.status >= 300) throw new Error(`Personal API failed with HTTP ${response.status}`);
  return response.body;
}, { path, body });
const mainWindow = async operation => application.evaluate(({ BrowserWindow }, operation) => {
  const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/personal/index.html'));
  if (!window) throw new Error('The owned personal window was not found');
  if (operation.kind === 'resize') window.setSize(operation.width, operation.height);
  if (process.env.AGENTROOM_AUTOMATION_VISIBLE === '1') { window.show(); window.focus(); }
  return { id: window.getMediaSourceId(), size: window.getSize(), minimum: window.getMinimumSize() };
}, operation);
const capture = async name => {
  const info = await mainWindow({ kind: 'focus' });
  await page.screenshot({ path: join(evidence, `${name}-renderer.png`) });
  if (process.env.AGENTROOM_AUTOMATION_VISIBLE !== '1') { captures.push({ name, nativeWindow: false, renderer: true, size: info.size }); return; }
  const windowId = info.id.split(':')[1];
  if (!/^\d+$/.test(windowId || '')) throw new Error('The owned native window has no capture ID');
  execFileSync('/usr/sbin/screencapture', ['-x', '-l', windowId, join(evidence, `${name}.png`)]);
  captures.push({ name, nativeWindow: true, renderer: true, size: info.size });
};
const openConnections = async () => {
  await page.getByTestId('im-settings').click();
  await page.getByTestId('personal-service-connect-cue').waitFor();
};
const scrollConnections = edge => page.getByTestId('personal-modal').evaluate((dialog, edge) => {
  for (const element of [dialog, ...dialog.querySelectorAll('*')]) {
    if (element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY)) element.scrollTop = edge === 'bottom' ? element.scrollHeight : 0;
  }
}, edge);
const windowFor = async route => {
  let found;
  await expect.poll(() => {
    found = application.windows().find(window => {
      if (window.isClosed()) return false;
      try { const url = new URL(window.url()); return url.origin === fakeOrigin && route.test(url.pathname); } catch { return false; }
    });
    return Boolean(found);
  }, { timeout: 30000, intervals: [100, 250] }).toBe(true);
  return found;
};
const currentFlow = async () => {
  let saved;
  await expect.poll(async () => {
    saved = await page.evaluate(() => { try { return JSON.parse(sessionStorage.getItem('agentstudio.personal.native-connection-flow') || 'null'); } catch { return null; } });
    return Boolean(saved?.flowId);
  }, { timeout: 10000, intervals: [50, 100] }).toBe(true);
  return saved.flowId;
};
const connect = async service => {
  phase = `connect-${service}`;
  await page.getByTestId(`personal-service-connect-${service}`).click();
  const flowId = await currentFlow();
  await native({ kind: 'progress', flowId });
  let loginWindow;
  if (service === 'cue') {
    loginWindow = await windowFor(/^\/cue-web\/login$/);
    // Deliver the fake redirect only to this test process. Never register a system
    // scheme or let it reach a stable app running elsewhere on the Mac.
    await application.evaluate(({ app, BrowserWindow }, { fakeOrigin }) => {
      const window = BrowserWindow.getAllWindows().find(item => {
        try { const url = new URL(item.webContents.getURL()); return url.origin === fakeOrigin && url.pathname === '/cue-web/login'; } catch { return false; }
      });
      if (!window) throw new Error('The synthetic Cue sign-in window was not found');
      const nonces = new Set();
      const guard = (event, target) => {
        let url; try { url = new URL(target); } catch { return; }
        if (url.protocol === 'http:' || url.protocol === 'https:') { if (url.origin !== fakeOrigin) event.preventDefault(); return; }
        event.preventDefault();
        if (url.protocol !== 'cuedev:' || url.hostname !== 'oauth' || url.pathname !== '/desktop-callback' || !url.searchParams.get('token')?.startsWith('web-token-')) throw new Error('Unexpected synthetic callback');
        const nonce = url.searchParams.get('nonce');
        if (!nonce || nonces.has(nonce)) return;
        nonces.add(nonce);
        globalThis.__agentStudioSyntheticCueCallbacks = (globalThis.__agentStudioSyntheticCueCallbacks || 0) + 1;
        app.emit('open-url', { preventDefault() {} }, target);
        if (!window.isDestroyed()) window.close();
      };
      window.webContents.prependListener('will-navigate', guard);
      window.webContents.prependListener('will-redirect', guard);
    }, { fakeOrigin });
    await loginWindow.locator('#login').click();
  } else if (service === 'muse' || service === 'dots') {
    loginWindow = await windowFor(new RegExp(`^/${service}/`));
    await loginWindow.locator('#login').click();
  } else loginWindow = await windowFor(/^\/grok\/web\/loginDeepControl$/);
  await expect.poll(async () => (await native({ kind: 'progress', flowId })).state, { timeout: 60000, intervals: [100, 300, 700] }).toBe('ready');
  await expect.poll(async () => {
    const catalog = await native({ kind: 'services' });
    const selected = catalog.instances.filter(instance => instance.service === service);
    return selected.length > 0 && selected.every(instance => instance.status === 'ready' && instance.connectionId);
  }, { timeout: 45000, intervals: [200, 500] }).toBe(true);
  // Let the actual UI poll receive terminal ready; do not replace its flow with a
  // test-only renderer state. Refresh then exposes the resulting connection badge.
  await expect(page.getByTestId(`personal-service-connect-${service}`)).toContainText('已连接', { timeout: 45000 });
  verify(true, `${service} completes its native synthetic sign-in and backend registration`);
  if (service === 'grokbot' && loginWindow && !loginWindow.isClosed()) await loginWindow.close();
  connectedServices.push(service);
};

// Read only this newly-created mock-keychain profile, inside its owned main
// process. No credential, header, callback URL or provider body leaves that process.
const providerSnapshot = async (cueInstanceId, samples) => application.evaluate(async ({ app, safeStorage }, input) => {
  const { readFileSync } = process.getBuiltinModule('node:fs');
  const { join } = process.getBuiltinModule('node:path');
  if (app.getPath('userData') !== input.profile) throw new Error('Synthetic profile ownership mismatch');
  const records = JSON.parse(safeStorage.decryptString(readFileSync(join(input.profile, 'personal-services/connectors.bin'))));
  const cue = records.find(record => record.id === input.cueInstanceId && record.service === 'cue');
  const key = cue?.data?.apiKey, task = cue?.data?.agent?.taskId;
  if (typeof key !== 'string' || !key.startsWith('cue-key-web-') || typeof task !== 'string' || !task.startsWith(`${key}-task-`)) throw new Error('The synthetic Cue account was not created by the fake web flow');
  const serialized = JSON.stringify(input.samples);
  const secrets = records.flatMap(record => [record.token, record.data?.apiKey, record.data?.accessToken, record.data?.refreshToken]).filter(value => typeof value === 'string' && value.length > 0);
  const response = await fetch(`${input.fakeOrigin}/cue/v2/task.listMessages?${new URLSearchParams({ task_id: task, order: 'desc', limit: '50' })}`, { headers: { 'x-manus-api-key': key }, redirect: 'error' });
  if (!response.ok) throw new Error('Synthetic provider readback failed');
  const body = await response.json();
  if (!body.ok || !Array.isArray(body.messages)) throw new Error('Synthetic provider returned an invalid readback');
  return {
    submitted: body.messages.filter(message => message.type === 'user_message' && message.user_message?.content?.includes(input.marker)).length,
    answers: body.messages.filter(message => message.type === 'assistant_message' && message.assistant_message?.content?.includes(input.marker)).length,
    originalHistoryPresent: body.messages.some(message => message.type === 'assistant_message' && message.assistant_message?.content === "Here's a two-day Kyoto plan."),
    publicSecretsAbsent: secrets.every(secret => !serialized.includes(secret)),
    cueCallbacks: globalThis.__agentStudioSyntheticCueCallbacks || 0,
  };
}, { profile, cueInstanceId, marker, samples, fakeOrigin });
const launch = async () => {
  application = await launchDesktopTest(_electron, { executablePath, args: packagedApp ? [] : [join(root, 'apps/desktop')], env });
  page = await application.firstWindow();
  await page.getByTestId("im-app").waitFor();

  page.on('pageerror', error => errors.push(String(error.message).split('\n')[0]));
  await page.getByTestId('im-rail').waitFor();
  verify(page.url().startsWith('file:'), 'the personal renderer loads from a bundled local file');
  if (packagedApp) verify(fileURLToPath(page.url().split('?')[0]).startsWith(`${packagedApp}/Contents/Resources/app/`), 'the tested renderer belongs to the explicit .app');
  verify(await application.evaluate(({ app }) => process.versions.electron === '45.2.1' && app.commandLine.hasSwitch('use-mock-keychain')), 'Electron 45.2.1 uses the isolated mock keychain');
};

try {
  const health = await fetch(`${fakeOrigin}/health`, { signal: AbortSignal.timeout(3000) }).then(response => response.json());
  const fakePage = await fetch(`${fakeOrigin}/muse/`, { signal: AbortSignal.timeout(3000) }).then(response => response.text());
  verify(health.ok === true && fakePage.includes('Muse (fake)') && fakePage.includes('id="login"'), 'the existing local synthetic service is reachable');
  await launch();
  const bridge = await page.evaluate(() => ({ keys: Object.keys(window.agentStudioPersonal).sort(), noLegacy: typeof window.agentStudioDesktop === 'undefined', noNode: typeof window.require === 'undefined' && typeof window.process === 'undefined' }));
  verify(bridge.noLegacy && bridge.noNode && bridge.keys.includes('nativeIntegration') && bridge.keys.every(key => ['platform', 'version', 'request', 'onChanged', 'onCommand', 'saveArtifact', 'restart', 'nativeIntegration'].includes(key)), 'the preload exposes only its declared personal capabilities');
  await openConnections(); await scrollConnections('top'); await capture('connections-top'); await scrollConnections('bottom'); await capture('connections-bottom');
  await scrollConnections('top');
  for (const service of ['cue', 'grokbot', 'muse', 'dots']) await connect(service);
  const catalog = await native({ kind: 'services' });
  verify(catalog.instances.length === 6, 'one login exposes two Cue agents, two Grok agents, Muse and Dots');
  const cue = catalog.instances.find(instance => instance.service === 'cue' && instance.name === 'Trip Planner');
  verify(Boolean(cue?.id && cue.connectionId), 'the synthetic Cue conversation has a bound backend connection');
  const initial = await api('/bootstrap');
  verify(initial.threads.filter(thread => thread.id !== initial.workspace?.guide?.threadId).length === 0 && initial.connections.length === 6, 'connecting services creates no imported personal chat history');
  phase = 'provider-readback-before';
  const before = await providerSnapshot(cue.id, [...publicSamples, initial]);
  verify(before.originalHistoryPresent && before.submitted === 0 && before.publicSecretsAbsent, 'provider history exists but no synthetic message or credential was imported');
  verify(before.cueCallbacks === 1, 'Cue default web login uses one synthetic callback delivered only to this app');
  await capture('connections-linked');
  const resized = await mainWindow({ kind: 'resize', width: 760, height: 620 });
  verify(resized.size[0] === 760 && resized.minimum[0] === 760, 'the actual native window reaches its 760px minimum width');
  const dimensions = await page.getByTestId('personal-modal').evaluate(dialog => ({ page: document.documentElement.scrollWidth <= innerWidth + 1, modal: dialog.scrollWidth <= dialog.clientWidth + 1 }));
  verify(dimensions.page && dimensions.modal, '760px native window and connections dialog have no horizontal overflow');
  for (const service of ['cue', 'grokbot', 'muse', 'dots']) {
    const button = page.getByTestId(`personal-service-connect-${service}`); await button.scrollIntoViewIfNeeded();
    verify(await button.evaluate(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1; }), `${service} connection action remains reachable at 760px`);
  }
  await scrollConnections('top'); await capture('connections-760');
  await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; }); await page.emulateMedia({ colorScheme: 'dark' });
  verify(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), 'dark appearance is active only in the test app');
  await capture('connections-dark-760');
  await page.keyboard.press('Escape'); await expect(page.getByTestId('personal-modal')).toHaveCount(0); verify(true, 'Escape closes the native connections dialog');
  await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; }); await page.emulateMedia({ colorScheme: null });
  await mainWindow({ kind: 'resize', width: 1200, height: 780 });
  phase = 'explicit-connection-task';
  await page.getByTestId('im-new').click(); await page.getByTestId('im-new-notes').click();
  await page.getByTestId('im-send-options-toggle').click(); await page.getByTestId('im-task-mode').selectOption('connection'); await page.getByTestId('im-task-connection').selectOption(cue.connectionId);
  await page.getByTestId('im-message-input').fill(taskText); await page.getByTestId('im-send').click();
  await page.waitForURL(/thread=thr_/); const threadId = new URL(page.url()).searchParams.get('thread');
  await page.getByTestId('im-pending-bar').click();
  await page.getByTestId('personal-decision-approve').waitFor({ timeout: 30000 });
  const waiting = await api(`/threads/${threadId}`);
  verify(waiting.status === 'needs_input' && waiting.runs[0].mode === 'connection' && waiting.runs[0].connectionId === cue.connectionId && waiting.artifacts.length === 0, 'the explicit service task awaits the precise approval without a result');
  verify((await providerSnapshot(cue.id, [waiting])).submitted === 0, 'the fake provider has received zero task submissions before approval');
  await capture('cue-exact-decision'); await page.getByTestId('personal-decision-approve').click();
  let completed;
  await expect.poll(async () => { completed = await api(`/threads/${threadId}`); return ['completed', 'failed', 'unknown', 'blocked'].includes(completed.status); }, { timeout: 60000, intervals: [250, 500] }).toBe(true);
  verify(completed.status === 'completed' && completed.artifacts.length === 1, 'the actual fake Cue reply becomes a saved native artifact');
  const artifact = await api(`/artifacts/${completed.artifacts[0].id}`);
  verify(artifact.source === 'a2a' && artifact.body.includes('Cue echo:') && artifact.body.includes(marker) && artifact.body.includes('中文') && artifact.body.includes('English'), 'the artifact contains the actual correlated Chinese and English fake reply');
  verify(createHash('sha256').update(artifact.body).digest('hex') === artifact.sha256, 'the saved synthetic artifact matches its SHA-256');
  const after = await providerSnapshot(cue.id, [...publicSamples, completed, artifact]);
  verify(after.submitted === 1 && after.answers === 1 && after.publicSecretsAbsent, 'the fake provider records exactly one approved send and its answer without public credentials');
  verify(!JSON.stringify(completed).includes('two-day Kyoto') && !JSON.stringify(completed).includes('Revenue was up 12%'), 'unrelated provider history is absent from task context and artifacts');
  await page.getByTestId('im-approval-open-chat').click();
  await page.getByTestId('im-results').click(); await page.getByTestId('im-artifact').last().click(); await page.getByTestId('personal-reader').waitFor(); await capture('cue-synthetic-result');
  phase = 'muse-contact-chat';
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const muse = catalog.instances.find(instance => instance.service === 'muse');
  const museContact = (await api('/contacts')).contacts.find(contact => contact.binding?.connectionId === muse.connectionId);
  verify(Boolean(museContact), 'the synthetic Muse service appears as an ordinary chat contact');
  await page.getByTestId('im-refresh').click(); await page.getByTestId('im-nav-contacts').click();
  await page.getByTestId(`im-contact-${museContact.id}`).click(); await page.getByTestId('im-start-chat').click();
  const museChatId = new URL(page.url()).searchParams.get('thread');
  for (let turn = 1; turn <= 2; turn++) {
    const turnMarker = `${marker}_TURN_${turn}`;
    await page.getByTestId('im-message-input').fill(`合成 Muse 聊天 ${turn} / Synthetic Muse chat ${turnMarker}`);
    await page.getByTestId('im-send').click();
    let reply;
    await expect.poll(async () => { reply = await api(`/threads/${museChatId}`); return reply.runs[turn - 1]?.status; }, { timeout: 60000 }).toBe('completed');
    verify(reply.decisions.length === 0 && reply.messages.at(-1).text.startsWith('Muse echo:') && reply.messages.at(-1).text.includes(turnMarker), `Muse chat turn ${turn} returns its actual correlated synthetic reply without approval`);
    await expect(page.getByTestId('im-pending-bar')).toHaveCount(0);
  }
  await capture('muse-contact-chat');
  const manifestBefore = JSON.parse(await readFile(join(profile, 'personal-services/manifest.json'), 'utf8'));
  verify(manifestBefore.tasks.length === 3 && manifestBefore.tasks.every(task => task.state === 'completed') && manifestBefore.tasks.filter(task => task.instanceId === muse.id).length === 2, 'one Cue task and two Muse chat receipts are durable before restart');
  await application.close(); application = undefined;
  phase = 'restart-readback'; await launch();
  let restored;
  await expect.poll(async () => { restored = await api('/bootstrap'); return restored.connections.length; }, { timeout: 45000, intervals: [250, 500] }).toBe(6);
  const restoredCatalog = await native({ kind: 'services' });
  verify(restoredCatalog.instances.length === 6 && restored.connections.map(item => item.id).sort().join() === initial.connections.map(item => item.id).sort().join(), 'restart restores the same six service identities without duplicate backend connections');
  const restoredThread = await api(`/threads/${threadId}`);
  verify(restoredThread.status === 'completed' && restoredThread.runs.length === 1 && restoredThread.artifacts[0].sha256 === artifact.sha256, 'restart preserves the original task, single run and exact artifact');
  const manifestAfter = JSON.parse(await readFile(join(profile, 'personal-services/manifest.json'), 'utf8'));
  verify(manifestAfter.chosenPort === manifestBefore.chosenPort && manifestAfter.tasks.map(task => task.id).join() === manifestBefore.tasks.map(task => task.id).join(), 'restart owns the same saved port and never creates another A2A task');
  const restoredMuse = await api(`/threads/${museChatId}`);
  verify(restoredMuse.runs.length === 2 && restoredMuse.runs.every(run => run.status === 'completed') && restoredMuse.decisions.length === 0, 'restart preserves both direct Muse replies without replay or approval records');
  const afterRestart = await providerSnapshot(cue.id, [...publicSamples, restored, restoredThread]);
  verify(afterRestart.submitted === 1 && afterRestart.answers === 1 && afterRestart.publicSecretsAbsent, 'provider readback confirms no additional send after restarting the app');
  verify(errors.length === 0, 'the synthetic native connection journeys have no renderer exceptions');
  const healthReadback = await api('/health');
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed: true, profile, packaged: Boolean(packagedApp), checks, errors, captures, connectedServices, callbackDelivery: 'synthetic fake redirect -> owned test app open-url; no system handler change', providerReadback: { before, after, afterRestart }, health: healthReadback, artifact: { size: artifact.size, sha256: artifact.sha256 }, scope: 'four synthetic native service logins; one explicitly approved fake Cue task; two direct fake Muse chat turns; no model execution or real accounts' }, null, 2));
  console.log(JSON.stringify({ evidence, checks: checks.length, passed: true }));
} catch (error) {
  await page?.screenshot({ path: join(evidence, 'failure-renderer.png') }).catch(() => {});
  const message = String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[url]').replace(/(?:fake-(?:access|refresh)-|cue-key-)[\w-]+/g, '[synthetic credential]');
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ passed: false, phase, message, checks, errors, profile, captures }, null, 2));
  throw new Error(`Synthetic native acceptance failed during ${phase}; evidence: ${evidence}`);
} finally { await application?.close(); }
