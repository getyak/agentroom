// Hidden Electron, isolated profile and synthetic Nango; no inference/accounts.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'apps/desktop/package.json'));
const { _electron, expect } = require('@playwright/test');
const outputRoot = resolve(process.env.AGENTROOM_MCP_NATIVE_EVIDENCE_DIR || 'output/playwright/mcp-native');
await mkdir(outputRoot, { recursive: true }); const output = await mkdtemp(join(outputRoot, 'native-'));
const checks = []; let session = 0, calls = 0;
const provider = http.createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const send = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
  if (request.url === '/sessions') {
    const body = JSON.parse(raw); assert.equal(body.expires_in, '1h'); assert.equal(body.tenant.connections.pinned[0].connection_id, 'synthetic-native');
    const id = `native-${++session}`;
    return send({ data: { session_id: id, session_token: `synthetic-native-session-token-${session}`, expires_at: new Date(Date.now() + 3600_000).toISOString(), mcp_url: `http://127.0.0.1:${provider.address().port}/session/${id}/mcp` } });
  }
  if (request.method === 'DELETE') return send({ data: {} });
  const rpc = JSON.parse(raw);
  if (rpc.method === 'notifications/initialized') return response.writeHead(202).end();
  const result = rpc.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } } : { tools: [{ name: 'synthetic_read', inputSchema: { type: 'object' } }] };
  if (rpc.method === 'tools/call') calls++;
  send({ jsonrpc: '2.0', id: rpc.id, result });
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const env = cleanDesktopTestEnv({ ...process.env, AGENTSTUDIO_USER_DATA_DIR: join(output, 'profile'), CODEX_HOME: join(output, 'codex-home'), AGENTSTUDIO_WORKSPACE: 'personal', AGENTSTUDIO_MOCK_KEYCHAIN: '1',
  AGENTSTUDIO_CODEX_BIN: join(output, 'missing'), AGENTSTUDIO_CLAUDE_BIN: join(output, 'missing'), AGENTSTUDIO_PI_BIN: join(output, 'missing') });
delete env.AGENTROOM_AUTOMATION_VISIBLE;
let app;
try {
  const bundle = process.env.AGENTSTUDIO_PACKAGED_APP;
  app = await launchDesktopTest(_electron, { executablePath: bundle ? join(bundle, 'Contents/MacOS/AgentRoom') : require('electron'), args: bundle ? [] : [join(root, 'apps/desktop')], env });
  const page = await app.firstWindow();
  await expect(page.getByTestId('im-app')).toBeVisible();
  const request = (path, body, method) => page.evaluate(async ({ path, body, method }) => {
    const result = await window.agentStudioPersonal.request({ path: `/api${path}`, method: method || (body === undefined ? 'GET' : 'POST'), ...(body === undefined ? {} : { body }) });
    if (result.status >= 300) throw new Error(`Synthetic IPC failed ${result.status}`);
    return result.body;
  }, { path, body, method });
  await page.getByTestId('im-settings').click();
  await page.getByTestId('personal-tab-connections').click();
  await page.getByTestId('personal-nango-toggle').click();
  await page.getByTestId('personal-nango-base-url').fill(`http://127.0.0.1:${provider.address().port}`);
  await page.getByTestId('personal-nango-api-key').fill('synthetic-native-admin-key');
  await page.getByTestId('personal-nango-integration-id').fill('native');
  await page.getByTestId('personal-nango-connection-id').fill('synthetic-native');
  await page.getByTestId('personal-nango-save').click();
  await expect(page.getByTestId('personal-nango-notice')).toContainText('Nango 已连接');
  const connection = (await request('/connections')).connections.find(item => item.nango);
  assert.ok(connection); assert.equal(session, 1); assert.equal(calls, 0);
  checks.push('native fixed IPC creates and reads a scoped Nango session');
  const scope = (await request('/mcp/access')).connections.find(item => item.id === connection.id).access;
  assert.equal(scope.enabled, false);
  assert.deepEqual((await request('/integrations/nango/recovery')).records, []);
  checks.push('native scope is disabled by default and recovery metadata is accessible without secrets');
  await page.getByTestId(`personal-nango-renew-${connection.id}`).click();
  await expect.poll(() => session).toBe(2);
  await expect.poll(async () => (await request('/connections')).connections[0].url).toContain('/session/native-2/mcp');
  await page.getByTestId(`personal-connection-remove-${connection.id}`).click();
  await expect.poll(async () => (await request('/connections')).connections.length).toBe(0);
  assert.equal(calls, 0); checks.push('native explicit renewal and deletion use the owned utility without tool execution');
  const window = await app.evaluate(({ BrowserWindow }) => ({ visible: BrowserWindow.getAllWindows()[0].isVisible(), focused: BrowserWindow.getAllWindows()[0].isFocused() }));
  assert.deepEqual(window, { visible: false, focused: false });
  checks.push('test remains hidden and isolated from the installed workspace');
  await page.screenshot({ path: join(output, 'native.png') });
  await writeFile(join(output, 'result.json'), JSON.stringify({ synthetic: true, checks, window }, null, 2));
  console.log(JSON.stringify({ output, checks, synthetic: true }));
} finally { await app?.close(); await new Promise(resolve => provider.close(resolve)); }
