// Isolated Electron/IPC/ACP acceptance. No real accounts, installs or models.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';
import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { _electron, expect } = require('@playwright/test');
const parent = resolve(process.env.AGENTROOM_ASSISTANT_NATIVE_EVIDENCE_DIR || 'output/playwright/assistant-management-native');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(join(parent, 'native-'));
const profile = join(output, 'profile'), home = join(output, 'synthetic-home');
await mkdir(home, { recursive: true });
const config = join(home, 'settings.json'), originalConfig = '{"syntheticOnly":true,"selectedModel":"existing-model"}\n';
await writeFile(config, originalConfig, { mode: 0o600 });
const cli = join(output, 'synthetic-gemini');
const fixture = resolve('dev/fixtures/acp-agent.mjs');
await writeFile(cli, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('gemini 1.2.3');process.exit(0)}\nprocess.argv[2]='chat';await import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });

// Existing data predates the native launch and must remain byte-for-byte equal.
const seed = await createPersonalServer({ dataDir: join(profile, 'personal'), port: 0, assistantManager: false, discoverLocalAgents: async () => ({ agents: [] }), autoGroupNetwork: false });
let historic;
try {
  seed.store.put('setting', { id: 'workspace-onboarding', completed: true });
  await seed.listen();
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${seed.address().port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  const contact = await api('/contacts', { kind: 'human', name: '历史联系人', handle: 'historic', clientId: 'seed-contact' });
  const chat = await api('/chats', { kind: 'direct', memberIds: [contact.id], clientId: 'seed-chat' });
  await api(`/threads/${chat.id}/messages`, { text: '既有聊天需要保留', clientId: 'seed-message' });
  historic = seed.store.require('thread', chat.id);
} finally { await seed.close(); }

let application, page;
const errors = [], checks = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
try {
  const env = cleanDesktopTestEnv({ ...process.env, HOME: home, CODEX_HOME: home, GEMINI_CLI_HOME: home,
    AGENTSTUDIO_USER_DATA_DIR: profile, AGENTSTUDIO_WORKSPACE: 'personal', AGENTSTUDIO_MOCK_KEYCHAIN: '1' });
  for (const id of ['CODEX', 'CLAUDE', 'PI', 'GEMINI', 'OPENCODE']) env[`AGENTSTUDIO_${id}_BIN`] = id === 'GEMINI' ? cli : '/missing-synthetic-assistant';
  const packaged = process.env.AGENTSTUDIO_PACKAGED_APP;
  application = await launchDesktopTest(_electron, { executablePath: packaged ? join(packaged, 'Contents/MacOS/AgentRoom') : require('electron'), args: packaged ? [] : [resolve('apps/desktop')], env, timeout: 30000 });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  const request = (path, body) => page.evaluate(async ({ path, body }) => window.agentStudioPersonal.request({ path: `/api${path}`, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body }) }), { path, body });
  const api = async (path, body) => { const response = await request(path, body); assert.ok(response.status < 400, JSON.stringify(response)); return response.body; };
  await expect(page.getByTestId('im-app')).toBeVisible();
  const catalog = await api('/assistants');
  assert.equal(catalog.entries.filter(entry => entry.kind === 'native').length, 5);
  assert.equal(catalog.entries.find(entry => entry.id === 'gemini').installedVersion, '1.2.3');
  assert.equal((await request('/assistants/install', { agentId: 'gemini', action: 'install', expectedVersion: '1.2.3', clientId: 'invalid', command: '/bad' })).status, 400);
  check('native IPC exposes verified inventory and rejects arbitrary installer commands');

  await page.getByTestId('im-new').click(); await page.getByTestId('im-new-contact').click();
  await expect(page.getByTestId('im-local-candidate-gemini')).toContainText('登录由原助手管理');
  await page.getByTestId('im-local-tab-discover').click();
  await page.getByTestId('im-local-search').fill('OpenCode');
  await expect(page.getByTestId('im-assistant-entry-opencode')).toBeVisible();
  await page.screenshot({ path: join(output, 'discover-native.png') });
  await page.getByTestId('im-local-tab-local').click(); await page.getByTestId('im-local-search').fill('');
  await page.getByTestId('im-local-action-gemini').click();
  await expect(page.getByTestId('im-message-input')).toBeVisible();
  const threadId = new URL(page.url()).searchParams.get('thread'); assert.ok(threadId);
  await api(`/threads/${threadId}/messages`, { text: '仅用于合成 ACP 验收', clientId: 'native-acp-send' });
  let thread;
  await expect.poll(async () => { thread = await api(`/threads/${threadId}`); return thread.runs.at(-1)?.status; }, { timeout: 20000 }).toBe('completed');
  assert.equal(thread.messages.at(-1).text, 'ACP 合成回复');
  assert.equal(thread.runs.at(-1).executionSnapshot.runtime.protocol, 'acp');
  assert.equal(thread.runs.at(-1).executionSnapshot.runtime.version, '1.2.3');
  check('native picker adopts Gemini once and streams a synthetic ACP reply through the native worker');
  const saved = await api(`/threads/${historic.id}`);
  assert.deepEqual(saved.messages, historic.messages);
  assert.deepEqual(saved.memberIds, historic.memberIds);
  assert.equal(await readFile(config, 'utf8'), originalConfig);
  assert.equal((await api('/assistants')).operations.length, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(output, 'acp-chat-native.png') });
  check('pre-existing chat, membership and account configuration survive; no installation started');
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ synthetic: true, packaged: Boolean(packaged), checks, errors, output }, null, 2));
} finally { await application?.close(); }
console.log(output);
