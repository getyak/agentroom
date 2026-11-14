import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAgentInfo, localAgentInfo, codexQuota } from './agent-info.mjs';

const checkedAt = '2026-11-14T08:00:00.000Z';
test('public metadata rejects malformed numbers and projects no credentials or account identity', () => {
  const info = publicAgentInfo({ model: 'model-a', thinking: 'high', checkedAt, token: 'PRIVATE', accountId: 'PRIVATE',
    quota: { status: 'available', credits: { balance: 'PRIVATE' }, windows: [{ remainingPercent: 120 }, { remainingPercent: '90' }, { remainingPercent: 60, windowMinutes: 300, resetsAt: 'invalid' }], accountId: 'PRIVATE' } });
  assert.equal(info.model, 'model-a'); assert.equal(info.thinking, 'high');
  assert.deepEqual(info.quota.windows, [{ remainingPercent: 60, windowMinutes: 300, resetsAt: null }]);
  assert.equal(info.quota.credits, null); assert.ok(!JSON.stringify(info).includes('PRIVATE'));
  assert.equal(publicAgentInfo({ quota: { status: 'available' } }).quota.status, 'unavailable');
});
test('local display retains a known model even when execution cannot resolve its thinking', () => {
  assert.equal(localAgentInfo({ defaults: { model: 'model-b', provider: 'custom', thinking: null } }, null, null, checkedAt).model, 'model-b');
});
test('a fixed model from another provider never inherits the default provider quota', () => {
  const quota = codexQuota({ rateLimits: { primary: { usedPercent: 25 } } }, checkedAt);
  const info = localAgentInfo({ defaults: { provider: 'openai' } }, { provider: 'custom', model: 'other-model' }, quota, checkedAt);
  assert.equal(info.quota.status, 'unavailable'); assert.equal(info.quota.reason, 'provider_managed');
  assert.deepEqual(info.quota.windows, []);
});
test('Codex usage uses the codex bucket and preserves zero remaining and decimal credits', () => {
  const quota = codexQuota({ accountId: 'PRIVATE', rateLimits: { primary: { usedPercent: 20 } }, rateLimitsByLimitId: { codex: {
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 12.5, windowDurationMins: 10080 }, credits: { unlimited: false, balance: '12.50' } } } }, checkedAt);
  assert.equal(quota.status, 'available'); assert.equal(quota.windows[0].remainingPercent, 0);
  assert.equal(quota.windows[1].remainingPercent, 87.5); assert.equal(quota.credits.balance, '12.50'); assert.equal(quota.checkedAt, checkedAt);
  assert.ok(!JSON.stringify(quota).includes('PRIVATE'));
});
