import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executeACP, inspectACP } from './acp-client.mjs';
const fixture = fileURLToPath(new URL('../../../dev/fixtures/acp-agent.mjs', import.meta.url));
const launch = mode => ({ command: process.execPath, args: [fixture, mode], protocol: 'acp', version: '1.0.0', agentId: 'acp_synthetic' });
async function work(run) { const dir = await mkdtemp(join(tmpdir(), 'agentroom-acp-')); try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
test('ACP handshakes without creating a model prompt or claiming authentication', () => work(async workspace => {
  const result = await inspectACP({ launch: launch('normal'), workspace });
  assert.equal(result.protocolVersion, 1); assert.equal(result.authenticationVerified, false);
}));
test('ACP preserves split UTF-8 text, ignores thinking and closes its own child', () => work(async workspace => {
  const events = []; let child;
  const result = await executeACP({ launch: launch('normal'), workspace, prompt: 'Synthetic only', onEvent: e => events.push(e), onProcess: c => { child = c; } });
  assert.equal(result.markdown, '你好，世界'); assert.ok(events.some(e => e.phase === 'writing'));
  assert.ok(!JSON.stringify(events).includes('PRIVATE_THINKING')); assert.notEqual(child.exitCode === null && child.signalCode === null, true);
}));
test('ACP rejects native permission requests and never silently grants access', () => work(async workspace => {
  const result = await executeACP({ launch: launch('permissions'), workspace, prompt: 'Synthetic only' });
  assert.equal(result.markdown, '权限已拒绝'); assert.equal(result.verification.permissionsDenied, 1);
}));
test('ACP reports unsupported protocol and malformed stdout as explicit failures', () => work(async workspace => {
  await assert.rejects(inspectACP({ launch: launch('version'), workspace }), { code: 'acp_version_unsupported' });
  await assert.rejects(executeACP({ launch: launch('invalid'), workspace, prompt: 'x' }), { code: 'acp_protocol_error' });
}));
test('ACP redacts provider diagnostics and reports authentication required', () => work(async workspace => {
  await assert.rejects(executeACP({ launch: launch('auth'), workspace, prompt: 'x' }), error => error.code === 'authentication_required' && !error.message.includes('SECRET'));
}));
test('ACP cancellation and timeout stop only the owned process', () => work(async workspace => {
  const controller = new AbortController();
  await assert.rejects(executeACP({ launch: launch('hang'), workspace, prompt: 'x', signal: controller.signal, onEvent: event => { if (event.phase === 'waiting') controller.abort(); } }), { code: 'cancelled' });
  await assert.rejects(executeACP({ launch: launch('hang'), workspace, prompt: 'x', timeoutMs: 80 }), { code: 'timeout' });
}));
test('ACP also stops a TERM-resistant descendant after its leader exits', { skip: process.platform === 'win32' }, () => work(async workspace => {
  let leader;
  try {
    const result = await executeACP({ launch: launch('descendant'), workspace, prompt: 'x', onProcess: child => { leader = child.pid; } });
    const pid = Number(result.markdown);
    let state = '';
    try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch {}
    assert.ok(!state || state.startsWith('Z'), `owned descendant ${pid} is still running (${state})`);
  } finally { if (leader) { try { process.kill(-leader, 'SIGKILL'); } catch {} } }
}));
