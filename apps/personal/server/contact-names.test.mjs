import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestContactName, discoveredContactName } from './contact-names.mjs';

const title = '# CanvasDesk · An agent service for rendering pages, posts and profile cards';

test('imported names use a recognizable heading and retain reasonable custom-looking provider names', () => {
  assert.equal(suggestContactName(title, 'Grok Bot', 'abcdef'), 'CanvasDesk');
  assert.equal(suggestContactName('## Research partner\nA long description follows', 'Grok Bot', 'abcdef'), 'Research partner');
  assert.equal(suggestContactName('产品品味官', 'Grok Bot', 'abcdef'), '产品品味官');
  assert.equal(suggestContactName('Ada · Lovelace', 'Grok Bot', 'abcdef'), 'Ada · Lovelace');
  assert.equal(suggestContactName('  My   partner  ', 'Grok Bot', 'abcdef'), 'My partner');
});

test('ambiguous long text gets a stable service label instead of an invented role or sliced transcript', () => {
  const source = 'Please analyze why somebody 2026/08/27 00:26 can renew a subscription later';
  assert.equal(suggestContactName(source, 'Grok Bot', 'abcdef'), 'Grok Bot · abcdef');
  assert.equal(suggestContactName('🧑‍💻'.repeat(18), '个人助手', '123456'), '个人助手 · 123456');
  assert.equal(suggestContactName('🧑‍💻 Research', 'Grok Bot', 'abcdef'), '🧑‍💻 Research');
});

test('discovery separates full source names and safely upgrades only untouched legacy imports', () => {
  assert.deepEqual(discoveredContactName(null, title, 'Grok Bot', 'abcdef'), { name: 'CanvasDesk', sourceName: title, nameSource: 'provider' });
  assert.equal(discoveredContactName({ name: title, providerName: title, version: 1 }, title, 'Grok Bot', 'abcdef').name, 'CanvasDesk');
  for (const previous of [
    { name: title, providerName: title, version: 2 },
    { name: title, providerName: title, version: 1, updatedAt: '2026-11-01T00:00:00Z' },
    { name: 'My chosen name', providerName: title, version: 1 },
    { name: 'Unknown origin', version: 1 },
  ]) {
    const next = discoveredContactName(previous, title, 'Grok Bot', 'abcdef');
    assert.equal(next.name, previous.name);
    assert.equal(next.nameSource, 'custom');
    assert.equal(next.sourceName, title);
  }
});

test('provider labels follow new names while explicit custom labels stay fixed', () => {
  const automatic = { name: 'CanvasDesk', sourceName: title, nameSource: 'provider', version: 2 };
  assert.equal(discoveredContactName(automatic, 'New provider name', 'Grok Bot', 'abcdef').name, 'New provider name');
  const custom = { ...automatic, nameSource: 'custom' };
  assert.equal(discoveredContactName(custom, 'New provider name', 'Grok Bot', 'abcdef').name, 'CanvasDesk');
});
