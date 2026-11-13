import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCcSwitch } from './cc-switch.mjs';

async function fixture(t, schema = true) {
  const home = await mkdtemp(join(tmpdir(), 'agentroom-cc-switch-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.cc-switch'); await mkdir(directory);
  const path = join(directory, 'cc-switch.db');
  const db = new DatabaseSync(path);
  if (schema) db.exec(`
    CREATE TABLE providers(app_type TEXT, name TEXT, is_current INTEGER, settings_config TEXT);
    CREATE TABLE mcp_servers(name TEXT, enabled_codex INTEGER, enabled_claude INTEGER, server_config TEXT);
    CREATE TABLE skills(name TEXT, enabled_codex INTEGER, enabled_claude INTEGER, directory TEXT);
    CREATE TABLE prompts(app_type TEXT, enabled INTEGER, content TEXT);
    CREATE TABLE profiles(payload TEXT);
    INSERT INTO providers VALUES('codex','synthetic provider',1,'PRIVATE_KEY');
    INSERT INTO mcp_servers VALUES('Synthetic tool',1,0,'PRIVATE_COMMAND');
    INSERT INTO skills VALUES('Synthetic skill',1,0,'PRIVATE_PATH');
    INSERT INTO prompts VALUES('codex',1,'PRIVATE_PROMPT');
    INSERT INTO profiles VALUES('PRIVATE_PAYLOAD');
  `);
  db.close(); return { home, path };
}

test('reads metadata without changing the database or exposing configuration contents', async t => {
  const { home, path } = await fixture(t), before = await readFile(path);
  const result = await readCcSwitch({ home });
  assert.equal(result.status, 'available');
  assert.equal(result.profiles, 1);
  const codex = result.clients.find(c => c.id === 'codex');
  assert.deepEqual(codex.providers, { total: 1, selected: 1 });
  assert.deepEqual(codex.mcp, { enabled: 1, names: ['Synthetic tool'], truncated: false });
  assert.deepEqual(codex.skills, { enabled: 1, names: ['Synthetic skill'], truncated: false });
  assert.equal(codex.prompts, 1);
  assert.equal(result.clients.find(c => c.id === 'pi').mcp, null);
  assert.equal(result.clients.find(c => c.id === 'claude').mcp.enabled, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|settings_config|server_config|payload|directory|content/);
  assert.deepEqual(await readFile(path), before);
});

test('missing file is not created and malformed databases remain unavailable', async t => {
  const { home, path } = await fixture(t);
  await rm(path);
  assert.equal((await readCcSwitch({ home })).status, 'not_found');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  await writeFile(path, 'PRIVATE_INVALID_DATABASE');
  assert.deepEqual(await readCcSwitch({ home }), { status: 'unavailable', clients: [], profiles: null });
});

test('unknown sections are null and views cannot stand in for expected tables', async t => {
  const { home, path } = await fixture(t, false);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE secrets(value TEXT); INSERT INTO secrets VALUES('PRIVATE_SECRET');
    CREATE VIEW providers AS SELECT 'codex' AS app_type, value AS name, 1 AS is_current FROM secrets;
    CREATE TABLE skills(name TEXT, enabled_codex INTEGER);
    INSERT INTO skills VALUES('Only known section',1);`);
  db.close();
  const result = await readCcSwitch({ home });
  assert.equal(result.status, 'available');
  const codex = result.clients.find(c => c.id === 'codex');
  assert.equal(codex.providers, null); assert.equal(codex.mcp, null); assert.equal(codex.prompts, null);
  assert.equal(codex.skills.enabled, 1); assert.equal(result.profiles, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('caps extension lists and labels, and reflects subsequent configuration changes', async t => {
  const { home, path } = await fixture(t);
  const db = new DatabaseSync(path);
  for (let i = 0; i < 55; i++) db.prepare('INSERT INTO skills VALUES(?,1,0,?)').run('x'.repeat(200) + i, 'PRIVATE_PATH');
  let result = await readCcSwitch({ home });
  let skills = result.clients.find(c => c.id === 'codex').skills;
  assert.equal(skills.enabled, 56); assert.equal(skills.names.length, 50); assert.equal(skills.truncated, true);
  assert.ok(skills.names.every(name => name.length <= 100));
  db.exec('UPDATE skills SET enabled_codex=0'); db.close();
  result = await readCcSwitch({ home });
  assert.equal(result.clients.find(c => c.id === 'codex').skills.enabled, 0);
});

test('rejects oversized files without opening or reading their content', async t => {
  const { home, path } = await fixture(t);
  await truncate(path, 128 * 1024 * 1024 + 1);
  assert.equal((await readCcSwitch({ home })).status, 'unavailable');
});

test('an exclusive database lock is bounded and a later refresh recovers', async t => {
  const { home, path } = await fixture(t);
  const db = new DatabaseSync(path);
  db.exec('BEGIN EXCLUSIVE');
  try { assert.equal((await readCcSwitch({ home })).status, 'unavailable'); }
  finally { db.exec('ROLLBACK'); db.close(); }
  assert.equal((await readCcSwitch({ home })).status, 'available');
});
