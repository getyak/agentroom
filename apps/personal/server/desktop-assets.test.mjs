import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalServer } from './index.mjs';

test('desktop HTTP serves only flat assets from its explicitly configured resource directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-browser-assets-'));
  const personal = join(root, 'renderer/personal'), assets = join(root, 'renderer/assets');
  await mkdir(personal, { recursive: true }); await mkdir(assets);
  await writeFile(join(personal, 'index.html'), '<!doctype html><script src="../assets/app.js"></script>');
  await writeFile(join(assets, 'app.js'), 'window.ASSET_OK=true');
  await writeFile(join(assets, 'font.woff2'), Buffer.from([0, 1, 2]));
  await writeFile(join(root, 'private.txt'), 'PRIVATE_RESOURCE_MUST_NOT_LEAK');
  await symlink(join(root, 'private.txt'), join(assets, 'leak.js'));
  const app = await createPersonalServer({ dataDir: join(root, 'data'), staticDir: personal, staticAssetsDir: assets, port: 0,
    codexCommand: '/missing-synthetic-agent', discoverLocalAgents: async () => ({ agents: [], checkedAt: new Date().toISOString() }) });
  await app.listen();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.address().port}`;
  const script = await fetch(origin + '/assets/app.js');
  assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/); assert.equal(await script.text(), 'window.ASSET_OK=true');
  const font = await fetch(origin + '/assets/font.woff2');
  assert.equal(font.status, 200); assert.equal(font.headers.get('content-type'), 'font/woff2');
  const missing = await fetch(origin + '/assets/missing.js'); assert.equal(missing.status, 404);
  const leak = await fetch(origin + '/assets/leak.js'); assert.equal(leak.status, 404); assert.doesNotMatch(await leak.text(), /PRIVATE_RESOURCE/);
  const head = await fetch(origin + '/assets/app.js', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
});
