import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { findWorkspace } from './open-personal-web.mjs';

const executable = '/Users/example/Applications/AgentRoom.app/Contents/MacOS/AgentRoom';
const revision = 'a'.repeat(40);
async function server(t, ref = revision) {
  const app = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, service: 'agentstudio-personal', build: { ref } }));
  }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return app.address().port;
}

test('opens the owned desktop runtime instead of a separate older web service', async t => {
  const current = await server(t), stale = await server(t, 'b'.repeat(40));
  const processes = `10 1 ${executable}\n20 10 ${executable.replace('MacOS/AgentRoom', 'Frameworks/AgentRoom Helper')}\n99 1 node`;
  const listeners = pid => pid === 20 ? `p20\nn127.0.0.1:${current}\n` : pid === 99 ? `p99\nn127.0.0.1:${stale}\n` : '';
  assert.equal(await findWorkspace({ executable, revision, processes, listeners }), `http://127.0.0.1:${current}`);
});

test('never adopts an unrelated service even when its build matches', async t => {
  const port = await server(t);
  await assert.rejects(findWorkspace({ executable, revision, processes: `10 1 ${executable}\n99 1 node`, listeners: pid => pid === 99 ? `n127.0.0.1:${port}\n` : '' }), /后台尚未就绪/);
});

test('rejects a worker whose source revision differs from the running bundle', async t => {
  const port = await server(t, 'b'.repeat(40));
  await assert.rejects(findWorkspace({ executable, revision, processes: `10 1 ${executable}\n20 10 helper`, listeners: pid => pid === 20 ? `n127.0.0.1:${port}\n` : '' }), /后台尚未就绪/);
});

test('never opens a same-build web server started by an agent task', async t => {
  const port = await server(t);
  await assert.rejects(findWorkspace({ executable, revision, processes: `10 1 ${executable}\n20 10 helper\n30 20 node`, listeners: pid => pid === 30 ? `n127.0.0.1:${port}\n` : '' }), /后台尚未就绪/);
});

test('does not choose between two application instances or start a replacement', async () => {
  await assert.rejects(findWorkspace({ executable, revision, processes: `10 1 ${executable}\n11 1 ${executable}`, listeners: () => { throw new Error('must not inspect ambiguous instances'); } }), /多个 AgentRoom 实例/);
});
