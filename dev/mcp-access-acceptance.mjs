// Synthetic account only: exercises actual Nango session assembly and scoped UI.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium } = createRequire(require.resolve('@playwright/test'))('playwright');
const { expect } = require('@playwright/test');
const root = resolve(process.env.AGENTROOM_MCP_EVIDENCE_DIR || 'output/playwright/mcp-access');
await mkdir(root, { recursive: true }); const output = await mkdtemp(join(root, 'browser-'));
const syntheticKey = 'synthetic-nango-browser-admin', sessionToken = 'synthetic-nango-session-token';
let sessions = 0, toolCalls = 0; const creations = [], revocations = [];
const provider = http.createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const send = body => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body)); };
  if (request.url === '/sessions') {
    assert.equal(request.headers.authorization, `Bearer ${syntheticKey}`);
    creations.push(JSON.parse(raw)); const id = `session-${++sessions}`;
    return send({ data: { session_id: id, session_token: `${sessionToken}-${sessions}`, mcp_url: `http://127.0.0.1:${provider.address().port}/session/${id}/mcp`, expires_at: new Date(Date.now() + 3600_000).toISOString() } });
  }
  if (request.method === 'DELETE') { revocations.push(request.url); return send({ data: {} }); }
  const rpc = JSON.parse(raw);
  if (rpc.method === 'notifications/initialized') return response.writeHead(202).end();
  let result;
  if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
  else if (rpc.method === 'tools/list') result = { tools: [{ name: 'read_trip', description: 'Synthetic trip read', inputSchema: { type: 'object' } }] };
  else { toolCalls++; return response.writeHead(400).end(); }
  send({ jsonrpc: '2.0', id: rpc.id, result });
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const app = await createPersonalServer({ dataDir: join(output, 'data'), port: 0, staticDir: resolve('apps/personal/dist'),
  discoverLocalAgents: async () => ({ agents: ['codex', 'claude'].map(id => ({ id, name: id, installed: true, auth: { status: 'configured' }, execution: { supported: true } })) }) });
let browser; const checks = [], errors = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
try {
  await app.listen(); const origin = `http://127.0.0.1:${app.address().port}`;
  let serial = 0;
  const api = async (path, body) => {
    const response = await fetch(`${origin}/api${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, clientId: `mcp-browser-${++serial}` }) } : {});
    const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
  };
  await api('/contacts');
  const planner = await api('/contacts', { kind: 'agent', name: '旅行规划师', handle: 'trip_planner', binding: { type: 'local', localAgentId: 'codex' } });
  const editor = await api('/contacts', { kind: 'agent', name: '旅行编辑', handle: 'trip_editor', binding: { type: 'local', localAgentId: 'claude' } });
  const chat = await api('/chats', { kind: 'group', title: '合成旅行群', memberIds: [planner.id, editor.id] });
  const other = await api('/chats', { kind: 'group', title: '合成创作群', memberIds: [planner.id, editor.id] });
  await api('/workspace/onboarding', { action: 'complete', name: 'Synthetic MCP QA' });
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const preferences = async () => { await page.getByTestId('im-settings').click(); await page.getByTestId('personal-tab-connections').click(); };
  await preferences();
  await page.getByTestId('personal-nango-toggle').click();
  await page.getByTestId('personal-nango-base-url').fill(`http://127.0.0.1:${provider.address().port}`);
  await page.getByTestId('personal-nango-api-key').fill(syntheticKey);
  await page.getByTestId('personal-nango-integration-id').fill('trip');
  await page.getByTestId('personal-nango-connection-id').fill('synthetic-owned-trip');
  await page.getByTestId('personal-nango-save').click();
  await expect(page.getByTestId('personal-nango-notice')).toContainText('Nango 已连接');
  const connection = (await api('/connections')).connections.find(item => item.nango);
  assert.ok(connection?.nango.expiresAt); assert.equal(sessions, 1); assert.equal(toolCalls, 0);
  assert.deepEqual(creations[0].tenant.connections.pinned, [{ integration_id: 'trip', connection_id: 'synthetic-owned-trip' }]);
  assert.equal(creations[0].meta_tools.nango_proxy, false);
  assert.equal(creations[0].meta_tools.nango_create_connection, false);
  assert.ok(!JSON.stringify(await api('/bootstrap')).includes(syntheticKey));
  assert.ok(!JSON.stringify(await api('/connections')).includes(sessionToken));
  assert.ok(!(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes(syntheticKey));
  check('Nango form creates one pinned session and retains all secrets in the vault');
  const prefix = `personal-mcp-access-${connection.id}`;
  await page.getByTestId(`${prefix}-toggle`).click();
  await expect(page.getByTestId(`${prefix}-enabled`)).not.toBeChecked();
  await page.getByTestId(`${prefix}-enabled`).check();
  await page.getByTestId(`${prefix}-contact-${planner.id}`).check();
  await page.getByTestId(`${prefix}-thread-${chat.id}`).check();
  await page.getByTestId(`${prefix}-thread-${other.id}`).check();
  await page.getByTestId(`${prefix}-save`).click();
  await expect(page.getByTestId(`${prefix}-notice`)).toContainText('范围已保存');
  await page.reload(); await preferences(); await page.getByTestId(`${prefix}-toggle`).click();
  await expect(page.getByTestId(`${prefix}-enabled`)).toBeChecked();
  await expect(page.getByTestId(`${prefix}-contact-${planner.id}`)).toBeChecked();
  check('scope starts disabled and saves agent/chat selections across reload');

  const current = (await api('/mcp/access')).connections.find(item => item.id === connection.id).access;
  await api(`/mcp/access/${connection.id}`, { ...current, enabled: false, id: undefined, updatedAt: undefined });
  await page.getByTestId('personal-mcp-access-refresh').click();
  await expect(page.getByTestId(`${prefix}-enabled`)).not.toBeChecked();
  await page.getByTestId(`${prefix}-enabled`).check();
  const newer = (await api('/mcp/access')).connections.find(item => item.id === connection.id).access;
  await api(`/mcp/access/${connection.id}`, { ...newer, enabled: false, id: undefined, updatedAt: undefined });
  await expect(page.getByTestId(`${prefix}-version-changed`)).toBeVisible();
  await expect(page.getByTestId(`${prefix}-enabled`)).toBeChecked();
  await page.getByTestId(`${prefix}-reload`).click();
  await expect(page.getByTestId(`${prefix}-enabled`)).not.toBeChecked();
  check('clean refresh follows latest settings and version conflict preserves the unsaved draft');

  await page.getByTestId(`personal-nango-renew-${connection.id}`).click();
  await expect.poll(() => sessions).toBe(2);
  await expect.poll(async () => (await api('/connections')).connections.find(item => item.id === connection.id).url).toContain('/session/session-2/mcp');
  assert.ok(revocations.includes('/sessions/session-1'));
  check('explicit renewal keeps the local connection and revokes the old Nango session');
  await page.getByTestId('personal-modal-close').click();
  await page.getByTestId(`im-chat-${chat.id}`).click();
  await page.getByTestId('im-results').click();
  await expect(page.getByTestId('personal-chat-mcp-access')).toBeVisible();
  await page.getByTestId(`${prefix}-toggle`).click();
  await page.getByTestId(`${prefix}-enabled`).check();
  await page.getByTestId(`${prefix}-contact-${planner.id}`).uncheck();
  await page.getByTestId(`${prefix}-contact-${editor.id}`).check();
  await page.getByTestId(`${prefix}-save`).click();
  await expect(page.getByTestId(`${prefix}-notice`)).toContainText('范围已保存');
  const scoped = (await api('/mcp/access')).connections.find(item => item.id === connection.id).access;
  assert.deepEqual(scoped.contactIds, [planner.id]);
  assert.deepEqual(scoped.threadContactIds[chat.id], [editor.id]);
  assert.ok(scoped.threadIds.includes(other.id));
  check('chat-specific agent override preserves other conversations and default agents');
  await page.screenshot({ path: join(output, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId(`${prefix}-save`)).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(output, 'narrow.png') });
  assert.equal(toolCalls, 0); assert.deepEqual(errors, []);
  check('narrow controls remain usable without overflow or accidental tool execution');
  await writeFile(join(output, 'result.json'), JSON.stringify({ synthetic: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ synthetic: true, output, checks: checks.length }));
} finally { await browser?.close(); await app.close(); await new Promise(resolve => provider.close(resolve)); }
