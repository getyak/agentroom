// Actual CLI, synthetic auth and local fake model endpoint. No real account or
// model request is used; inspect the actual outgoing prompt, never user history.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, stat, lstat, access } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { executeLocalAgent } from '../apps/personal/server/local-agents.mjs';
import { ToolSessions } from '../apps/personal/server/tool-sessions.mjs';
import { guestCodexSession } from '../apps/personal/server/play-executor.mjs';
import { spawn, spawnSync } from 'node:child_process';

const evidence = process.env.AGENTROOM_EVIDENCE_DIR;
if (!evidence) throw new Error('Set managed AGENTROOM_EVIDENCE_DIR');
const output = await mkdtemp(join(evidence, 'codex-isolation-')), home = join(output, 'home'), work = join(output, 'work');
await mkdir(home); await mkdir(work); await mkdir(join(home, 'skills/private'), { recursive: true }); await mkdir(join(home, 'memories'));
const canary = 'SYNTHETIC_PRIVATE_OWNER_CANARY_72D3';
const hook = join(output, 'notify.mjs'), hookReceipt = join(output, 'hook-ran');
await writeFile(hook, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(hookReceipt)},'unexpected');`);
await writeFile(join(work, 'AGENTS.md'), canary);
await writeFile(join(home, 'config.toml'), `model="gpt-6.1-sol"\nmodel_provider="openai"\nmodel_reasoning_effort="medium"\ndeveloper_instructions=${JSON.stringify(canary)}\nnotify=${JSON.stringify([process.execPath, hook])}\n[features]\nmemories=true\nhooks=true\nskill_search=true\n`);
await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-local-only' }), { mode: 0o600 });
await writeFile(join(home, 'AGENTS.md'), canary); await writeFile(join(home, 'memories/memory_summary.md'), canary);
await writeFile(join(home, 'skills/private/SKILL.md'), `---\nname: private-owner\ndescription: ${canary}\n---\n${canary}`);
const captured = [], paths = [], diagnostics = [];
const server = createServer(async (request, response) => {
  paths.push(`${request.method} ${request.url}`);
  let text = ''; for await (const chunk of request) text += chunk;
  if (request.method !== 'POST' || !request.url.includes('/responses')) { response.writeHead(404); response.end('{}'); return; }
  captured.push(text); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const message = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '公开房间测试回复', annotations: [] }] };
  for (const event of [
    { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: '公开房间测试回复' },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const broker = new ToolSessions(); await broker.listen();
const session = broker.open({ roomId: 'pr_fixture' }, [{ name: 'room_read', description: 'Read only this published room', inputSchema: { type: 'object', properties: {} } }], () => ({ brief: 'PUBLIC_ROOM_ONLY' }));
let isolated;
try {
  const sourceEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: process.env.TMPDIR };
  isolated = process.argv.includes('--unsafe-control') ? { deps: { home, env: sourceEnv }, close: async () => {} } : await guestCodexSession(work, { home, env: sourceEnv });
  const ownerAuth = join(home, 'auth.json'), inode = (await stat(ownerAuth)).ino;
  const login = spawnSync('codex', ['login', '--with-api-key'], { env: isolated.deps.env, input: 'synthetic-local-only', encoding: 'utf8', timeout: 10000 });
  assert.equal(login.status, 0, 'Synthetic CLI auth write-through did not succeed');
  assert.equal((await stat(ownerAuth)).ino, inode, 'CLI replaced owner auth file');
  if (!process.argv.includes('--unsafe-control')) assert.ok((await lstat(join(isolated.deps.env.CODEX_HOME, 'auth.json'))).isSymbolicLink());
  const baselineAuth = await readFile(ownerAuth, 'utf8');
  const result = await executeLocalAgent({ id: 'codex', prompt: 'PUBLIC_ROOM_ONLY: just say hello.', workspace: work, signal: AbortSignal.timeout(30000), isolateUserContext: !process.argv.includes('--unsafe-control'),
    executionSnapshot: { provider: 'openai', model: 'gpt-6.1-sol', thinking: 'medium' }, toolSession: session,
    deps: { ...isolated.deps, spawn: (command, args, options) => {
      // Only this synthetic harness replaces transport at the trusted spawn seam.
      // Provider config flags force loopback HTTP; OPENAI_BASE_URL is ignored by
      // the installed CLI and must not accidentally send synthetic auth outside.
      const executing = args[0] === 'exec' && !args.includes('--help');
      if (executing) args = [...args, '-c', 'model_provider="synthetic-local"', '-c', `model_providers.synthetic-local={name="Local test only",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",env_key="OPENAI_API_KEY",supports_websockets=false,requires_openai_auth=false}`, '-c', 'forced_login_method="api"'];
      if (executing) options = { ...options, env: { ...options.env, OPENAI_API_KEY: 'synthetic-local-only' } };
      const child = (isolated.deps.spawn || spawn)(command, args, options); if (executing) child.stderr.on('data', bytes => diagnostics.push(bytes.toString().split(session.token).join('[session]'))); return child;
    }, executionTimeoutMs: 30000 } });
  assert.ok(captured.length > 0, 'CLI did not reach the local fake provider');
  assert.ok(!captured.join('').includes(canary), 'Private synthetic instructions reached the model');
  assert.ok(captured.every(body => body.includes('PUBLIC_ROOM_ONLY')));
  assert.equal(await access(hookReceipt).then(() => true, () => false), false, 'Owner notify hook ran');
  assert.ok(result.markdown.includes('公开房间测试回复'));
  assert.equal(await readFile(ownerAuth, 'utf8'), baselineAuth, 'This no-refresh model call modified owner auth');
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ status: 'passed', actualCLI: true, localFakeProvider: true, requestCount: captured.length, privateCanaryAbsent: true, hookDidNotRun: true, actualAuthWriteThrough: true, sameOwnerAuthInode: true, modelCallDidNotModifyAuth: true }));
  console.log(`Codex prompt isolation passed: ${output}`);
} finally { await writeFile(join(output, 'diagnostics.json'), JSON.stringify({ paths, captured: captured.map(text => ({ privateCanaryPresent: text.includes(canary), canaryContext: text.includes(canary) ? text.slice(Math.max(0, text.indexOf(canary) - 160), text.indexOf(canary) + 160) : null, publicContextPresent: text.includes('PUBLIC_ROOM_ONLY') })), stderr: diagnostics.join('').slice(-8000) })); await isolated?.close(); session.close(); await broker.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); console.log(`Isolation test evidence: ${output}`); }
