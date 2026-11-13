// Synthetic approvals only: the fixture never invokes a real model or account.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';

const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium, expect } = requireDesktop('@playwright/test');
const parent = resolve(process.env.AGENTROOM_DECISIONS_EVIDENCE_DIR || 'output/playwright/decisions');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(join(parent, 'browser-'));
const calls = [], checks = [], errors = [];
const remote = http.createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  try {
    const rpc = JSON.parse(body); let result;
    if (rpc.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Synthetic approvals', version: '1' } };
    else if (rpc.method === 'tools/list') result = { tools: [{ name: 'write_note', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } }] };
    else if (rpc.method === 'tools/call') { calls.push(rpc); result = { content: [{ type: 'text', text: 'Synthetic result saved by the local fixture.' }] }; }
    else throw new Error('Unsupported fixture request');
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  } catch { response.writeHead(400).end(); }
});
let app, browser;
const action = { toolName: 'write_note', arguments: { text: 'Exact synthetic content' } };
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
try {
  await new Promise(resolveListen => remote.listen(0, '127.0.0.1', resolveListen));
  app = await createPersonalServer({ dataDir: join(output, 'data'), port: 0, staticDir: resolve('apps/personal/dist'), discoverLocalAgents: async () => ({ agents: [] }), codexCommand: '/missing-synthetic-approvals-cli' });
  app.store.put('connection', { id: 'synthetic_tools', type: 'mcp', name: '合成笔记工具', url: `http://127.0.0.1:${remote.address().port}/mcp` });
  await app.listen();
  const base = `http://127.0.0.1:${app.address().port}`;
  const api = async (path, body) => {
    const response = await fetch(`${base}/api${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.ok, true, `Synthetic request ${path} returned ${response.status}`); return response.json();
  };
  const first = await api('/threads', { text: '合成验收：保存这一份明确内容。', mode: 'connection', connectionId: 'synthetic_tools', action, clientId: randomUUID() });
  await expect.poll(async () => (await api(`/threads/${first.id}`)).status).toBe('needs_input');
  let current = await api(`/threads/${first.id}`);
  const firstId = current.decisions[0].id;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  page.on('pageerror', error => errors.push(error.message));
  const openChat = () => page.goto(`${base}/?thread=${first.id}`);
  const inline = () => page.getByTestId('im-inline-decision').filter({ has: page.getByTestId('personal-decision').filter({ has: page.getByTestId('personal-decision-approve') }) });
  await openChat();
  await expect(inline()).toHaveCount(1);
  await expect(page.getByTestId('personal-decision')).toHaveAttribute('data-decision-id', firstId);
  assert.equal(calls.length, 0);
  await page.getByTestId('im-nav-approvals').click();
  await page.getByTestId(`im-approval-${firstId}`).click();
  await expect(page.getByTestId('personal-decision')).toHaveAttribute('data-decision-id', firstId);
  await page.getByTestId('im-approval-open-chat').click();
  check('chat and inbox expose the same durable request before any dispatch');
  await page.getByTestId('personal-decision-approve-conversation').locator('..').locator('summary').click();
  await page.getByTestId('personal-decision-approve-conversation').click();
  await expect.poll(async () => (await api(`/threads/${first.id}`)).status).toBe('completed');
  await expect(page.getByTestId('personal-decision-grant')).toContainText('剩余 9/10');
  await api(`/threads/${first.id}/messages`, { text: '相同工具和参数，再做一次。', mode: 'connection', connectionId: 'synthetic_tools', action, clientId: randomUUID() });
  await expect.poll(async () => { current = await api(`/threads/${first.id}`); return current.runs.length === 2 && current.status === 'completed'; }).toBe(true);
  assert.equal(calls.length, 2); assert.notEqual(calls[0].id, calls[1].id);
  await page.reload();
  await expect(page.getByTestId('personal-decision-grant').first()).toContainText('剩余 8/10');
  await page.getByTestId('personal-decision-revoke').first().click();
  await expect(page.getByTestId('personal-decision-grant').first()).toContainText('后续授权已撤销');
  await api(`/threads/${first.id}/messages`, { text: '撤销后需要重新确认。', mode: 'connection', connectionId: 'synthetic_tools', action, clientId: randomUUID() });
  await expect.poll(async () => (await api(`/threads/${first.id}`)).status).toBe('needs_input');
  await page.reload(); await expect(inline()).toHaveCount(1); assert.equal(calls.length, 2);
  check('explicit exact-operation reuse survives reload and revocation prevents later dispatch');
  current = await api(`/threads/${first.id}`); const pendingId = current.decisions.at(-1).id;
  await page.getByTestId('im-nav-approvals').click(); await page.getByTestId(`im-approval-${pendingId}`).click();
  await page.getByTestId('personal-decision-approve').click();
  await expect.poll(async () => (await api(`/threads/${first.id}`)).status).toBe('completed');
  await page.getByTestId('im-approval-open-chat').click();
  await expect(page.getByTestId('personal-decision-approve')).toHaveCount(0); assert.equal(calls.length, 3);
  check('a once-only choice in the inbox is reflected in the original chat');
  // Seed provider observations in this isolated store; no provider response is sent.
  app.store.updateThread(first.id, thread => {
    const common = { kind: 'provider_approval', version: 1, requestType: 'choice', preview: '{}', summary: '原应用权限的合成观察', createdAt: new Date().toISOString(), decision: null };
    thread.decisions.push({ ...common, id: 'original_permission', title: '原应用处理权限', state: 'pending', authority: 'original_app_only', choices: [{ key: 'allow', label: 'Allow' }] });
    thread.decisions.push({ ...common, id: 'accepted_choice', title: '选择已由原服务接收', state: 'decided', authority: 'provider', choices: [], choiceLabel: 'Continue', deliveryState: 'delivered', actionState: 'completed', verificationState: 'verified' });
  });
  await page.reload();
  await expect(page.getByTestId('personal-decision-original')).toBeVisible();
  await expect(page.getByTestId('personal-decision-allow')).toHaveCount(0);
  await expect(page.getByTestId('personal-decision-open-original')).toHaveCount(0);
  const accepted = page.getByTestId('personal-decision').filter({ hasText: '选择已由原服务接收' });
  await expect(accepted).toContainText('选择已送达'); await expect(accepted).not.toContainText('执行：'); await expect(accepted).not.toContainText('核验：');
  await page.screenshot({ path: join(output, 'chat-decisions.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('personal-decision-original')).toBeVisible();
  await page.screenshot({ path: join(output, 'narrow-decisions.png'), fullPage: true });
  assert.deepEqual(errors, []); check('original-app-only and delivered provider choices remain truthful on wide and narrow screens');
} finally {
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ synthetic: true, checks, errors, dispatchedOperations: calls.length }, null, 2));
  await browser?.close(); await app?.close(); remote.closeAllConnections(); await new Promise(resolveClose => remote.close(resolveClose));
}
