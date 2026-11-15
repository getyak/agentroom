import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAgentProfile, readPiIdentity, resolveExecution, validateConfiguration } from './agent-profiles.mjs';

test('Pi profile follows changed saved defaults and exports no credential-bearing configuration', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agent-profile-')); t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.pi/agent'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth.json'), 'NOT EVEN JSON - do not read credentials');
  await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: { synthetic: { apiKey: 'DO_NOT_EXPORT', headers: { Authorization: 'DO_NOT_EXPORT' }, models: [{ id: 'a', name: 'Model A', reasoning: true }, { id: 'b', reasoning: true }] } } }));
  const save = model => writeFile(join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'synthetic', defaultModel: model, defaultThinkingLevel: 'high', modelThinkingLevels: { 'synthetic/b': 'low' }, secret: 'DO_NOT_EXPORT' }));
  await save('a'); const first = await readAgentProfile('pi', { home, env: {} });
  assert.equal(first.defaults.model, 'a'); assert.equal(first.defaults.thinking, 'high');
  assert.ok(!JSON.stringify(first).includes('DO_NOT_EXPORT')); assert.ok(!JSON.stringify(first).includes('Authorization'));
  await save('b'); const next = await readAgentProfile('pi', { home, env: {} });
  assert.equal(next.defaults.model, 'b'); assert.notEqual(first.version, next.version);
  assert.equal(resolveExecution(next, {}).thinking, 'low');
  assert.equal(resolveExecution(next, { modelMode: 'fixed', provider: 'synthetic', model: 'a', thinking: 'medium' }).model, 'a');
  assert.equal(resolveExecution(next, { modelMode: 'fixed', provider: 'synthetic', model: 'a', thinking: 'medium' }).thinking, 'medium');
  assert.throws(() => resolveExecution(next, { modelMode: 'fixed', provider: 'other', model: 'absent' }), /模型/);
});

test('contact configuration only admits documented scalar model options', () => {
  assert.throws(() => validateConfiguration({ modelMode: 'fixed', provider: 'synthetic', model: '--override' }), /模型/);
  assert.throws(() => validateConfiguration({ thinking: 'secret', command: 'arbitrary' }), /配置/);
  assert.equal(validateConfiguration({}).modelMode, 'follow');
});

test('Pi rejects unsupported per-model effort instead of silently reporting a clamped level', () => {
  const profile = { agentId: 'pi', defaults: { provider: 'fixture', model: 'a', thinking: 'high' }, models: [{ provider: 'fixture', id: 'a', reasoning: true, thinkingLevels: ['off', 'low', 'medium', 'high'] }], providers: ['fixture'], thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] };
  assert.throws(() => resolveExecution(profile, { thinking: 'max' }), /不支持/);
  assert.equal(resolveExecution(profile).thinking, 'high');
});

test('identity preview only reads the two Pi identity files on explicit request', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-identity-')); t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.pi/agent'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SYSTEM.md'), 'You are a synthetic research companion.');
  await writeFile(join(directory, 'APPEND_SYSTEM.md'), 'Check primary sources.');
  await writeFile(join(directory, 'AGENTS.md'), 'DO_NOT_IMPORT_WORKSPACE_INSTRUCTIONS');
  const profile = await readAgentProfile('pi', { home, env: {} });
  assert.ok(!JSON.stringify(profile).includes('synthetic research companion'));
  const result = await readPiIdentity({ home, env: {} });
  assert.equal(result.instructions, 'You are a synthetic research companion.\n\nCheck primary sources.');
  assert.equal(result.truncated, false); assert.ok(!JSON.stringify(result).includes('DO_NOT_IMPORT'));
});

test('Codex selected profile never becomes an implicit OpenAI provider override', async t => {
  const home = await mkdtemp(join(tmpdir(), 'codex-profile-')); t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.codex'));
  await writeFile(join(home, '.codex/config.toml'), 'profile = "selected"\n\n[profiles.selected]\nmodel = "fixture-model"\nmodel_provider = "fixture-provider"\nmodel_reasoning_effort = "high"\n');
  const profile = await readAgentProfile('codex', { home, env: {} });
  assert.equal(profile.defaults.provider, 'fixture-provider');
  assert.equal(resolveExecution(profile, {}).model, 'fixture-model');
  assert.equal(resolveExecution(profile, {}).thinking, 'high');
});

test('Claude can follow its own defaults without requiring an explicit model or effort in settings', async t => {
 const home = await mkdtemp(join(tmpdir(), 'claude-defaults-')); t.after(() => rm(home, { recursive: true, force: true }));
 const profile = await readAgentProfile('claude', { home, env: {} });
 const execution = resolveExecution(profile, { modelMode: 'follow', thinking: 'follow' });
 assert.equal(execution.provider, 'anthropic'); assert.equal(execution.model, null); assert.equal(execution.thinking, null);
 assert.throws(() => resolveExecution(profile, { modelMode: 'fixed', provider: 'anthropic', model: '' }));
});
