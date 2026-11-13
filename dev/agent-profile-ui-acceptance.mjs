// Isolated renderer acceptance: synthetic contacts and API responses, no model or account calls.
// Build personal first. AGENTSTUDIO_AGENT_PROFILE_EVIDENCE_DIR can point to a guarded artifact directory.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import http from 'node:http';

const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium } = createRequire(requireDesktop.resolve('@playwright/test'))('playwright');
const { expect } = requireDesktop('@playwright/test');
const staticDir = resolve('apps/personal/dist');
const output = resolve(process.env.AGENTSTUDIO_AGENT_PROFILE_EVIDENCE_DIR || 'output/playwright/agent-profile-ui');
await mkdir(output, { recursive: true });
const checks = [], errors = [], mutations = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const now = new Date().toISOString();
const profile = { agentId: 'codex', defaults: { provider: 'synthetic', model: 'synthetic-model', thinking: 'medium' }, models: [], providers: ['synthetic'], thinkingLevels: ['low', 'medium', 'high'], modelThinkingLevels: {}, source: '合成配置', version: '1', description: '' };
const person = (id, fields = {}) => ({ id, name: id, kind: 'agent', handle: id, description: '', instructions: '', color: 'blue', version: 1, availability: 'ready', binding: { type: 'local', localAgentId: 'codex' }, configuration: { modelMode: 'follow', thinking: 'follow' }, execution: { agentId: 'codex', provider: 'synthetic', model: 'synthetic-model', thinking: 'medium' }, profile, providerName: 'Synthetic Codex', ...fields });
let contacts = [person('agent_codex', { name: '本机助手', discovered: true }), person('researcher', { name: '研究伙伴' }), person('remote', { name: '远端伙伴', binding: { type: 'connection', connectionId: 'con_remote' }, profile: null }), person('unavailable', { name: '未连接助手', availability: 'disconnected' }), person('tool', { name: '合成工具联系人', discovered: true, availability: 'configuration_required', binding: { type: 'connection', connectionId: 'con_tool' }, connectionType: 'mcp', chatBackend: null, execution: null, profile: null, providerName: 'Synthetic Tool' }), person('human', { name: '本地联系人', kind: 'human', availability: 'local_only', binding: null }), person('self', { name: '你', kind: 'human', availability: 'self', binding: null })];
const thread = (id, kind, memberIds) => ({ id, kind, memberIds, title: kind === 'group' ? '合成讨论室' : '研究伙伴', status: 'completed', summary: '', version: 1, createdAt: now, updatedAt: now, lastMessage: null, messages: Array.from({ length: 30 }, (_, index) => ({ id: `msg_${id}_${index}`, role: index % 2 ? 'assistant' : 'user', text: `合成消息 ${index + 1}。\n\n这段内容只用于验证打开设置后保留阅读位置和未发送草稿。`, createdAt: now, contactId: index % 2 ? 'researcher' : 'self' })), runs: [], artifacts: [], decisions: [], events: [] });
const threads = { thr_direct: thread('thr_direct', 'direct', ['self', 'researcher']), thr_group: thread('thr_group', 'group', ['self', 'researcher', 'remote', 'unavailable', 'tool', 'human']) };
const controls = Object.fromEntries(contacts.filter(contact => contact.kind === 'agent').map(contact => [contact.id, { contactId: contact.id, version: 1, goal: { text: '', status: 'paused' }, scheduler: { enabled: false, mode: 'interval', intervalMinutes: 60, time: '09:00', timeZone: 'Asia/Shanghai', maxRunsPerDay: 4 }, supported: !['unavailable', 'tool'].includes(contact.id), autonomousSupported: !['remote', 'unavailable', 'tool'].includes(contact.id), unsupportedReason: contact.id === 'unavailable' ? '连接已移除，目标仍可保存在本机。' : contact.id === 'tool' ? '工具操作需要逐项确认，暂不支持自动调度。' : '', state: 'idle', nextRunAt: null, runsToday: 0, recentRuns: [] }]));
const receipts = new Map();
let conflictNextSave = false, dropNextSave = false;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const file = resolve(staticDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(`${staticDir}${sep}`)) { res.writeHead(403).end(); return; }
    const content = await readFile(file);
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
    res.end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await context.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice(4);
    const body = request.postDataJSON();
    const fulfill = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'POST') mutations.push({ path, body });
    if (path === '/bootstrap') return fulfill({ threads: Object.values(threads), connections: [], memories: [], settings: { defaultMode: 'local', codexAvailable: true } });
    if (path === '/contacts') return fulfill({ contacts });
    if (path === '/approvals') return fulfill({ approvals: [] });
    if (path === '/library/artifacts' && request.method() === 'GET') return fulfill({ artifacts: [] });
    if (path.startsWith('/threads/')) return fulfill(threads[path.split('/')[2]]);
    const controlMatch = path.match(/^\/contacts\/([^/]+)\/(control|run)$/);
    if (controlMatch) {
      const [, id, action] = controlMatch;
      const control = controls[id];
      if (request.method() === 'GET') return fulfill(control);
      if (receipts.has(body.clientId)) return fulfill(receipts.get(body.clientId));
      if (action === 'control' && conflictNextSave) {
        conflictNextSave = false; control.version += 1;
        return fulfill({ error: { code: 'conflict', message: '设置已在另一处更新，当前编辑尚未保存。' } }, 409);
      }
      assert.equal(body.version, control.version);
      if (action === 'control' && body.scheduler.enabled) assert.equal(body.goal.status, 'active');
      if (action === 'run') {
        const runId = 'run_synthetic';
        Object.assign(control, { state: 'queued', nextRunAt: null, runsToday: control.runsToday + 1, recentRuns: [{ runId, threadId: 'thr_direct', status: 'queued', createdAt: now }] });
        const result = { control: structuredClone(control), threadId: 'thr_direct', runId };
        receipts.set(body.clientId, result); return fulfill(result);
      }
      Object.assign(control, { version: control.version + 1, goal: body.goal, scheduler: body.scheduler, state: body.goal.status === 'paused' ? 'paused' : body.scheduler.enabled ? 'scheduled' : 'idle', nextRunAt: body.scheduler.enabled && body.goal.status === 'active' ? new Date(Date.now() + 3600000).toISOString() : null });
      receipts.set(body.clientId, structuredClone(control));
      if (dropNextSave) { dropNextSave = false; return route.abort('failed'); }
      return fulfill(control);
    }
    const contactMatch = path.match(/^\/contacts\/([^/]+)$/);
    if (contactMatch && body) {
      const id = contactMatch[1];
      contacts = contacts.map(contact => contact.id === id ? { ...contact, ...body, version: contact.version + 1 } : contact);
      return fulfill(contacts.find(contact => contact.id === id));
    }
    errors.push(`Unexpected API request: ${request.method()} ${path}`);
    return fulfill({ error: { message: 'Unexpected test request' } }, 404);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/?thread=thr_direct`);
  await expect(page.getByTestId('im-chat-info')).toContainText('研究伙伴');
  await expect(page.getByTestId('im-header-status')).toBeHidden();
  await expect(page.getByTestId('im-chat-info')).not.toContainText('synthetic-model');
  await page.getByTestId('im-message-input').fill('尚未发送的聊天草稿');
  await page.getByTestId('im-timeline').evaluate(node => { node.scrollTop = 120; node.dispatchEvent(new Event('scroll')); });
  const scrollTop = await page.getByTestId('im-timeline').evaluate(node => node.scrollTop);
  await page.getByTestId('im-chat-info').click();
  await expect(page.getByTestId('im-agent-control')).toBeVisible();
  await expect(page.getByTestId('im-agent-schedule-enabled')).not.toBeChecked();
  check('quiet chat header opens contextual settings with scheduling off by default');

  await page.getByTestId('im-agent-goal').fill('每次整理一项项目待办，并记录结果。');
  await page.getByTestId('im-agent-schedule-enabled').check();
  await page.getByTestId('im-agent-schedule-mode').selectOption('daily');
  await page.getByTestId('im-agent-schedule-time').fill('10:30');
  await page.getByTestId('im-agent-schedule-timezone').fill('Asia/Shanghai');
  await page.getByTestId('im-agent-schedule-mode').selectOption('autonomous');
  await page.getByTestId('im-agent-schedule-interval').fill('30');
  await page.getByTestId('im-agent-save').click();
  await expect(page.getByTestId('im-agent-notice')).toContainText('已保存');
  assert.equal(controls.researcher.scheduler.mode, 'autonomous');
  assert.equal(controls.researcher.scheduler.intervalMinutes, 30);
  await expect(page.getByTestId('im-agent-next-run')).not.toContainText('尚无安排');
  check('explicit save persists per-agent goal, schedule mode, limits and next run');

  await page.getByTestId('im-agent-goal').fill('修改中的目标草稿');
  await page.getByTestId('im-agent-basic').click();
  await page.getByTestId('im-contact-advanced').click();
  await page.getByTestId('im-model-options-toggle').click();
  await expect(page.getByTestId('im-model-policy')).toBeVisible();
  await page.getByTestId('im-contact-name').fill('研究伙伴已改名');
  await page.getByTestId('im-contact-save').click();
  await expect(page.getByTestId('im-contact-editor')).toHaveCount(0);
  await expect(page.getByTestId('im-agent-goal')).toHaveValue('修改中的目标草稿');
  await page.getByTestId('im-agent-save').click();
  await expect(page.getByTestId('im-agent-notice')).toContainText('已保存');
  await page.getByTestId('personal-modal-close').last().click();
  await expect(page.getByTestId('im-message-input')).toHaveValue('尚未发送的聊天草稿');
  assert.equal(await page.getByTestId('im-timeline').evaluate(node => node.scrollTop), scrollTop);
  assert.equal(new URL(page.url()).searchParams.get('thread'), 'thr_direct');
  check('identity/model editing returns to goal draft and preserves chat draft, route and scroll');

  await page.getByTestId('im-chat-info').click();
  await page.getByTestId('im-agent-pause').click();
  await expect(page.getByTestId('im-agent-state')).toHaveText('已暂停');
  await expect(page.getByTestId('im-agent-schedule-enabled')).not.toBeChecked();
  await page.getByTestId('im-agent-goal-status').selectOption('active');
  await page.getByTestId('im-agent-schedule-enabled').uncheck();
  await page.getByTestId('im-agent-save').click();
  await expect(page.getByTestId('im-agent-run-now')).toBeEnabled();
  await page.getByTestId('im-agent-run-now').click();
  await expect(page.getByTestId('im-agent-history')).toContainText('已排队');
  assert.equal(mutations.filter(item => item.path.endsWith('/run')).length, 1);
  assert.equal(new URL(page.url()).searchParams.get('thread'), 'thr_direct');
  check('pause and run now act only on this agent and manual execution keeps the current chat');

  conflictNextSave = true;
  await page.getByTestId('im-agent-goal').fill('冲突时保留的目标编辑');
  await page.getByTestId('im-agent-save').click();
  await expect(page.getByTestId('im-agent-error')).toContainText('另一处更新');
  await expect(page.getByTestId('im-agent-goal')).toHaveValue('冲突时保留的目标编辑');
  await page.getByTestId('im-agent-reload').click();
  await expect(page.getByTestId('im-agent-goal')).toHaveValue('修改中的目标草稿');
  await page.getByTestId('im-agent-goal').fill('网络重试仍为同一次保存');
  dropNextSave = true;
  await page.getByTestId('im-agent-save').click();
  await expect(page.getByTestId('im-agent-error')).toBeVisible();
  await expect(page.getByTestId('im-agent-goal')).toHaveValue('网络重试仍为同一次保存');
  await page.getByTestId('im-agent-save').click();
  await expect(page.getByTestId('im-agent-notice')).toContainText('已保存');
  const retry = mutations.filter(item => item.path === '/contacts/researcher/control').slice(-2);
  assert.equal(retry[0].body.clientId, retry[1].body.clientId);
  check('conflicts preserve edits and ambiguous save failures reuse the original request id');
  await page.getByTestId('personal-modal-close').last().click();

  await page.getByTestId('im-chat-thr_group').click();
  await page.getByTestId('im-message-input').fill('群聊中的未发送草稿');
  await page.getByTestId('im-chat-info').click();
  await page.getByTestId('im-group-name').fill('尚未保存的群名称');
  const membership = [...threads.thr_group.memberIds];
  await page.getByTestId('im-member-profile-remote').click();
  await expect(page.getByTestId('im-agent-goal')).toHaveValue('');
  await page.getByTestId('im-agent-schedule-enabled').check();
  assert.equal(await page.getByTestId('im-agent-schedule-mode').evaluate(node => Array.from(node.options).find(option => option.value === 'autonomous').disabled), true);
  await page.getByTestId('personal-modal-close').last().click();
  await expect(page.getByTestId('im-group-name')).toHaveValue('尚未保存的群名称');
  await page.getByTestId('im-member-profile-unavailable').click();
  await expect(page.getByTestId('im-agent-unsupported')).toContainText('连接已移除');
  await expect(page.getByTestId('im-agent-schedule-enabled')).toBeDisabled();
  await expect(page.getByTestId('im-agent-run-now')).toBeDisabled();
  await page.getByTestId('im-agent-goal').fill('暂未连接时先记下目标');
  await page.getByTestId('im-agent-save').click();
  await expect(page.getByTestId('im-agent-notice')).toContainText('已保存');
  await page.getByTestId('personal-modal-close').last().click();
  await page.getByTestId('im-member-profile-human').click();
  await expect(page.getByTestId('im-agent-basic')).toBeVisible();
  await expect(page.getByTestId('im-agent-control')).toHaveCount(0);
  await page.getByTestId('personal-modal-close').last().click();
  await expect(page.getByTestId('im-member-researcher')).toBeChecked();
  assert.deepEqual(threads.thr_group.memberIds, membership);
  assert.equal(mutations.filter(item => item.path.startsWith('/chats/')).length, 0);
  await page.getByTestId('personal-modal-close').last().click();
  await expect(page.getByTestId('im-message-input')).toHaveValue('群聊中的未发送草稿');
  check('group inspection preserves group edits and membership, with truthful remote, unsupported and human capabilities');

  await page.getByTestId('im-chat-info').click();
  await page.getByTestId('im-member-profile-tool').click();
  await page.getByTestId('im-agent-basic').click();
  await expect(page.getByTestId('im-contact-chat-backend')).toHaveValue('');
  await expect(page.getByTestId('im-contact-chat-backend-hint')).toContainText('才能发送新消息');
  await expect(page.getByTestId('im-agent-options')).toHaveCount(0);
  const toolBinding = { type: 'connection', connectionId: 'con_tool' };
  const chosenChatBackend = { type: 'local', localAgentId: 'codex' };
  await expect(page.getByTestId('im-contact-backend')).toHaveValue(JSON.stringify(toolBinding));
  await page.getByTestId('im-contact-chat-backend').selectOption(JSON.stringify(chosenChatBackend));
  await page.getByTestId('im-contact-advanced').click();
  await expect(page.getByTestId('im-detected-model')).toHaveText('synthetic-model');
  await page.getByTestId('im-model-options-toggle').click();
  await expect(page.getByTestId('im-model-policy')).toHaveValue('follow');
  await page.getByTestId('im-contact-save').click();
  await expect(page.getByTestId('im-contact-editor')).toHaveCount(0);
  const savedTool = mutations.filter(item => item.path === '/contacts/tool').at(-1)?.body;
  assert.deepEqual(savedTool.binding, toolBinding);
  assert.deepEqual(savedTool.chatBackend, chosenChatBackend);
  assert.deepEqual(savedTool.configuration, { modelMode: 'follow', thinking: 'follow' });
  await page.getByTestId('im-agent-basic').click();
  await expect(page.getByTestId('im-contact-chat-backend')).toHaveValue(JSON.stringify(chosenChatBackend));
  await page.getByTestId('im-contact-advanced').click();
  await expect(page.getByTestId('im-detected-model')).toHaveText('synthetic-model');
  await page.getByTestId('personal-modal-close').last().click();
  await page.getByTestId('personal-modal-close').last().click();
  await page.getByTestId('personal-modal-close').last().click();
  await expect(page.getByTestId('im-message-input')).toHaveValue('群聊中的未发送草稿');
  check('MCP tool contacts require an explicit chat assistant choice and preserve tool binding with its selected backend model options');

  await page.getByTestId('im-chat-info').click();
  await page.getByTestId('im-member-profile-researcher').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('im-agent-goal')).toBeVisible();
  assert.equal(await page.getByTestId('im-agent-profile').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: join(output, 'narrow-profile.png') });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.screenshot({ path: join(output, 'dark-profile.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('im-agent-profile')).toHaveCount(0);
  await expect(page.getByTestId('im-group-editor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('im-group-editor')).toHaveCount(0);
  check('narrow, dark and reduced-motion views fit and Escape returns through the dialog stack');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ checks, errors, synthetic: true }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
