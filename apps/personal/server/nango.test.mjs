import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore, id } from './store.mjs';
import { CredentialVault } from './vault.mjs';
import { NangoConnections } from './nango.mjs';

const apiKey = 'synthetic-nango-admin-key';
const input = { apiKey, integrationId: 'notion', connectionId: 'owned-notion-connection', toolNames: ['read_doc'], clientId: 'synthetic-connect-1' };
function session(number = 1, extra = {}) {
  return { session_id: `synthetic-session-${number}`, session_token: `synthetic-session-token-${number}`,
    mcp_url: `https://api.nango.dev/session/synthetic-session-${number}/mcp`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), ...extra };
}
async function fixture(t, { responseSession, failSave = () => false, post = null, deletion = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nango-synthetic-'));
  const store = new PersonalStore(directory), requests = [], saves = [];
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let number = 0;
  const fetcher = async (url, options) => {
    requests.push({ url, ...options, body: options.body && JSON.parse(options.body) });
    if (options.method === 'DELETE') return deletion ? deletion(url, options) : new Response(null, { status: 204 });
    number++;
    if (post) return post(number, url, options);
    return Response.json({ data: responseSession ? responseSession(number) : session(number) });
  };
  const saveConnection = async (body, options) => {
    saves.push({ body, options });
    if (failSave()) throw new Error(`synthetic verification failure ${body.token} ${apiKey}`);
    const fingerprint = store.vault.fingerprint(body.token, body.type, body.url);
    const existing = store.list('connection').find(connection => connection.url === body.url && connection.type === body.type && connection.credentialFingerprint === fingerprint);
    if (existing) return { id: existing.id, name: existing.name, type: existing.type, url: existing.url, connected: true };
    const connection = { id: id('con'), name: body.name, type: body.type, url: body.url, credentialVersion: 1, createdAt: new Date().toISOString(),
      initializedAt: new Date().toISOString(), sessionId: `mcp-${number}`, protocolVersion: '2025-11-25' };
    connection.credentialRef = store.vault.create(body.token, connection);
    connection.credentialFingerprint = store.vault.fingerprint(body.token, connection.type, connection.url);
    store.put('connection', connection);
    return { id: connection.id, name: connection.name, type: connection.type, url: connection.url, connected: true };
  };
  return { directory, store, requests, saves, manager: new NangoConnections(store, { fetch: fetcher, saveConnection }) };
}

test('creates one pinned session with exact tools and disabled proxy/dynamic connections; secrets stay only in encrypted vault', async t => {
  const { manager, store, requests, saves, directory } = await fixture(t);
  const result = await manager.connect(input);
  assert.deepEqual(requests[0].body, {
    tenant: { connections: { pinned: [{ integration_id: 'notion', connection_id: 'owned-notion-connection' }] } },
    toolset: { notion: { allow: { tools: ['read_doc'] } } }, expires_in: '1h',
    meta_tools: { nango_tool_search: true, nango_execute: true, nango_proxy: false, nango_create_connection: false },
  });
  assert.equal(requests[0].url, 'https://api.nango.dev/sessions');
  assert.equal(requests[0].headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(requests[0].redirect, 'error'); assert.ok(requests[0].signal);
  assert.equal(saves[0].options.verifyTools, true);
  assert.equal(saves[0].body.token, session().session_token);
  assert.equal(result.nango.integrationId, 'notion'); assert.ok(result.nango.expiresAt);
  const privateRecord = store.require('nango_connection', result.id);
  assert.equal(privateRecord.sessionId, 'synthetic-session-1');
  const documents = store.db.prepare('SELECT body FROM documents').all();
  const receipts = store.db.prepare('SELECT body FROM idempotency').all();
  const serialized = JSON.stringify({ result, documents, receipts });
  assert.ok(!serialized.includes(apiKey)); assert.ok(!serialized.includes(session().session_token));
  assert.ok(!JSON.stringify(result).includes('cred_'));
  assert.equal(store.vault.authorization(store.require('connection', result.id)).Authorization, `Bearer ${session().session_token}`);
  for (const name of await readdir(join(directory, 'vault', 'credentials'))) {
    const ciphertext = await readFile(join(directory, 'vault', 'credentials', name), 'utf8');
    assert.ok(!ciphertext.includes(apiKey)); assert.ok(!ciphertext.includes(session().session_token));
  }
  const replay = await manager.connect(input); assert.deepEqual(replay, result); assert.equal(requests.length, 1);
});

test('missing tool allowlist means only all tools in the pinned integration', async t => {
  const { manager, requests } = await fixture(t);
  await manager.connect({ ...input, toolNames: [] });
  assert.deepEqual(requests[0].body.toolset, { notion: '*' });
});

test('rejects unsafe base URLs and wildcard tool names before any request', async t => {
  const { manager, requests } = await fixture(t);
  for (const baseUrl of ['http://example.com', 'https://api.nango.dev/nested', 'https://name@api.nango.dev', 'https://api.nango.dev/?key=x', 'https://api.nango.dev/#x']) {
    await assert.rejects(manager.connect({ ...input, baseUrl }), { status: 400 });
  }
  await assert.rejects(manager.connect({ ...input, toolNames: ['*'] }), { status: 400 });
  assert.equal(requests.length, 0);
});

test('rejects unknown connect fields before making an admin request', async t => {
  const { manager, requests } = await fixture(t);
  for (const extra of [{ meta_tools: { nango_proxy: true } }, { tenant: { connections: { any: [] } } }, { expires_in: '15d' }, { token: 'synthetic-other-token' }]) {
    await assert.rejects(manager.connect({ ...input, ...extra }), { status: 400 });
  }
  assert.equal(requests.length, 0);
});

test('rejects hostile MCP URL, wrong session path, invalid expiry/token and revokes known unused sessions', async t => {
  for (const override of [
    { mcp_url: 'https://hostile.example/session/synthetic-session-1/mcp' },
    { mcp_url: 'https://api.nango.dev/session/another-session/mcp' },
    { mcp_url: 'https://api.nango.dev/session/synthetic-session-1/mcp?key=secret' },
    { expires_at: 'not-a-time' }, { expires_at: new Date(Date.now() - 1000).toISOString() },
    { session_token: 'bad token' },
  ]) {
    const { manager, store, requests, saves } = await fixture(t, { responseSession: number => session(number, override) });
    await assert.rejects(manager.connect(input), { status: 502 });
    assert.equal(saves.length, 0); assert.equal(store.list('connection').length, 0);
    assert.equal(requests.filter(request => request.method === 'DELETE').length, 1);
  }
});

test('renewal keeps connection id, changes credential identity and initializes fresh after vault reload', async t => {
  const { manager, store, requests, saves, directory } = await fixture(t);
  const first = await manager.connect(input), before = store.require('connection', first.id);
  store.vault.close(); store.vault = new CredentialVault(directory);
  const restarted = new NangoConnections(store, { fetch: manager.fetch, saveConnection: manager.saveConnection });
  const renewed = await restarted.renew(first.id, { clientId: 'synthetic-renew-1' });
  const after = store.require('connection', first.id);
  assert.equal(renewed.id, first.id); assert.equal(store.list('connection').length, 1);
  assert.equal(after.credentialVersion, before.credentialVersion + 1);
  assert.notEqual(after.credentialRef, before.credentialRef); assert.notEqual(after.url, before.url);
  assert.equal(after.sessionId, 'mcp-2'); assert.equal(saves[1].options.verifyTools, true);
  assert.equal(store.vault.authorization(after).Authorization, 'Bearer synthetic-session-token-2');
  assert.equal(requests[1].headers.Authorization, `Bearer ${apiKey}`);
  assert.ok(requests.some(request => request.method === 'DELETE' && request.url.endsWith('/synthetic-session-1')));
  assert.deepEqual(await manager.renew(first.id, { clientId: 'synthetic-renew-1' }), renewed);
});

test('verification failure preserves original connection and revokes unused new session, with sanitized errors', async t => {
  let fail = false;
  const { manager, store, requests } = await fixture(t, { failSave: () => fail });
  const first = await manager.connect(input), before = store.require('connection', first.id), metadata = store.require('nango_connection', first.id);
  fail = true;
  await assert.rejects(manager.renew(first.id, { clientId: 'synthetic-renew-fail' }), error => {
    assert.ok(!error.message.includes(apiKey)); assert.ok(!error.message.includes('synthetic-session-token-2')); return true;
  });
  assert.deepEqual(store.require('connection', first.id), before); assert.deepEqual(store.require('nango_connection', first.id), metadata);
  assert.ok(requests.some(request => request.method === 'DELETE' && request.url.endsWith('/synthetic-session-2')));
});

test('uncertain creation is never retried by same clientId and never leaks upstream error or key', async t => {
  const { manager, requests } = await fixture(t, { post: async () => { throw new Error(`timeout ${apiKey}`); } });
  await assert.rejects(manager.connect(input), error => error.code === 'nango_session_outcome_unknown' && !error.message.includes(apiKey));
  await assert.rejects(manager.connect(input), { code: 'nango_session_outcome_unknown' });
  assert.equal(requests.length, 1);
});

test('concurrent duplicate requests create only one remote session and changed request conflicts', async t => {
  const { manager, requests } = await fixture(t);
  const [first, second] = await Promise.all([manager.connect(input), manager.connect(input)]);
  assert.deepEqual(first, second); assert.equal(requests.length, 1);
  await assert.rejects(manager.connect({ ...input, connectionId: 'different-connection' }), { status: 409 });
});

test('disconnect revokes best effort, removes admin binding/metadata and reports uncertain remote status', async t => {
  for (const uncertain of [false, true]) {
    const { manager, store } = await fixture(t, { deletion: uncertain ? async () => { throw new Error('offline'); } : null });
    const connection = await manager.connect(input), beforeCount = store.vault.recordNames().length;
    const result = await manager.disconnect(connection.id);
    assert.equal(result.remoteRevocation, uncertain ? 'unconfirmed' : 'revoked');
    assert.equal(store.get('nango_connection', connection.id), null);
    assert.ok(store.get('connection', connection.id));
    assert.equal(store.vault.recordNames().length, beforeCount - 1);
  }
});

test('response streams are bounded and a real session creation timeout has no automatic retry', async t => {
  const oversized = await fixture(t, { post: async () => Response.json({ data: { ...session(), padding: 'x'.repeat(128_001) } }) });
  await assert.rejects(oversized.manager.connect(input), { code: 'nango_session_outcome_unknown' });
  assert.equal(oversized.saves.length, 0);
  const slow = await fixture(t, { post: async () => { await new Promise(resolve => setTimeout(resolve, 35)); return Response.json({ data: session() }); } });
  slow.manager.timeoutMs = 5;
  await assert.rejects(slow.manager.connect(input), { code: 'nango_session_outcome_unknown' });
  await assert.rejects(slow.manager.connect(input), { code: 'nango_session_outcome_unknown' });
  assert.equal(slow.requests.length, 1);
});

test('failed atomic replacement rolls back original and cleans candidate credentials and unused remote session', async t => {
  const { manager, store, requests } = await fixture(t);
  const first = await manager.connect(input), before = store.require('connection', first.id), metadata = store.require('nango_connection', first.id);
  const put = store.put.bind(store);
  store.put = (kind, value) => { if (kind === 'nango_connection') throw new Error('synthetic storage failure'); return put(kind, value); };
  await assert.rejects(manager.renew(first.id));
  assert.deepEqual(store.require('connection', first.id), before); assert.deepEqual(store.require('nango_connection', first.id), metadata);
  assert.equal(store.list('connection').length, 1); assert.equal(store.vault.recordNames().length, 2);
  assert.ok(requests.some(request => request.method === 'DELETE' && request.url.endsWith('/synthetic-session-2')));
});

test('a provider cannot echo an admin secret in its public MCP URL/session identity', async t => {
  for (const reflectedId of [apiKey, session().session_token, `prefix-${apiKey}-suffix`, `prefix-${session().session_token}-suffix`]) {
    const { manager, saves, requests } = await fixture(t, { responseSession: () => session(1, { session_id: reflectedId, mcp_url: `https://api.nango.dev/session/${reflectedId}/mcp` }) });
    await assert.rejects(manager.connect(input), { code: 'invalid_nango_session' });
    assert.equal(saves.length, 0);
    for (const request of requests) {
      assert.ok(!request.url.includes(apiKey), 'an admin secret must never become a request URL, including during cleanup');
      assert.ok(!request.url.includes(session().session_token), 'a session token must never become a request URL, including during cleanup');
    }
  }
});

test('renewal remains successful if obsolete local credential cleanup fails after commit', async t => {
  const { manager, store } = await fixture(t);
  const first = await manager.connect(input), old = store.require('connection', first.id);
  const remove = store.vault.remove.bind(store.vault);
  store.vault.remove = ref => { if (ref === old.credentialRef) throw new Error('synthetic obsolete credential cleanup failure'); return remove(ref); };
  const renewed = await manager.renew(first.id);
  assert.equal(renewed.id, first.id); assert.equal(renewed.credentialCleanupPending, true);
  assert.equal(store.require('nango_connection', first.id).sessionId, 'synthetic-session-2');
});

test('uncertain renewal preserves original and only a new explicit renewal creates another session', async t => {
  const { manager, store, requests } = await fixture(t, { post: async number => {
    if (number === 2) throw new Error('synthetic connection reset after possible creation');
    return Response.json({ data: session(number) });
  } });
  const first = await manager.connect(input), before = store.require('connection', first.id);
  await assert.rejects(manager.renew(first.id, { clientId: 'uncertain-renew-1' }), { code: 'nango_session_outcome_unknown' });
  assert.deepEqual(store.require('connection', first.id), before);
  await assert.rejects(manager.renew(first.id, { clientId: 'uncertain-renew-1' }), { code: 'nango_session_outcome_unknown' });
  assert.equal(requests.filter(request => request.method === 'POST').length, 2);
  const explicit = await manager.renew(first.id, { clientId: 'explicit-renew-2' });
  assert.equal(explicit.id, first.id); assert.equal(store.require('nango_connection', first.id).sessionId, 'synthetic-session-3');
});

test('provider session reuse cannot migrate or delete another connection or revoke its shared session', async t => {
  for (const sameToken of [true, false]) {
    const { manager, store, requests, saves } = await fixture(t, { responseSession: number => number <= 2 ? session(number) : session(1, {
      session_token: sameToken ? session(1).session_token : session(number).session_token,
    }) });
    const first = await manager.connect(input), connection = store.require('connection', first.id), metadata = store.require('nango_connection', first.id);
    const second = await manager.connect({ ...input, integrationId: 'github', clientId: 'different-connect-2' });
    const secondConnection = store.require('connection', second.id), secondMetadata = store.require('nango_connection', second.id);
    await assert.rejects(manager.connect({ ...input, integrationId: 'linear', clientId: 'different-connect-3' }), { code: 'nango_session_already_connected' });
    await assert.rejects(manager.renew(second.id), { code: 'nango_session_already_connected' });
    assert.deepEqual(store.require('connection', first.id), connection);
    assert.deepEqual(store.require('nango_connection', first.id), metadata);
    assert.deepEqual(store.require('connection', second.id), secondConnection);
    assert.deepEqual(store.require('nango_connection', second.id), secondMetadata);
    assert.equal(store.list('connection').length, 2); assert.equal(store.vault.recordNames().length, 4);
    assert.equal(saves.length, 2); assert.equal(requests.filter(request => request.method === 'DELETE').length, 0);
  }
});
