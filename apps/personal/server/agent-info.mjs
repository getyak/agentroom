// Public display facts only. Never project account IDs, credentials or raw responses.
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,159}$/.test(value) ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
export function publicAgentInfo(value, { source = '接入服务', checkedAt = null } = {}) {
  const input = value || {}, quota = input.quota || {};
  const windows = (Array.isArray(quota.windows) ? quota.windows : []).slice(0, 8).flatMap(window =>
    finite(window?.remainingPercent, 0, 100) ? [{ remainingPercent: window.remainingPercent,
      windowMinutes: finite(window.windowMinutes, 1, 525600) ? window.windowMinutes : null, resetsAt: date(window.resetsAt) }] : []);
  const credits = quota.credits?.unlimited === true ? { unlimited: true, balance: null }
    : typeof quota.credits?.balance === 'string' && /^\d{1,16}(\.\d{1,8})?$/.test(quota.credits.balance) ? { unlimited: false, balance: quota.credits.balance } : null;
  const available = quota.status === 'available' && (windows.length > 0 || credits !== null);
  return { model: identifier(input.model), provider: identifier(input.provider), thinking: identifier(input.thinking),
    source, checkedAt: date(input.checkedAt) || date(checkedAt),
    quota: { status: available ? 'available' : 'unavailable', provider: identifier(quota.provider), windows: available ? windows : [], credits: available ? credits : null,
      checkedAt: date(quota.checkedAt), source: quota.source === 'Codex 账户用量' ? quota.source : source,
      reason: available ? null : ['not_supported', 'not_provided', 'read_failed', 'login_required', 'provider_managed'].includes(quota.reason) ? quota.reason : 'not_provided' } };
}

export function localAgentInfo(profile, execution, quota, checkedAt) {
  const configuration = execution || profile?.defaults;
  const applicable = quota?.provider && quota.provider !== configuration?.provider
    ? { status: 'unavailable', reason: 'provider_managed', provider: configuration?.provider } : quota;
  return publicAgentInfo({ ...configuration, quota: applicable, checkedAt }, { source: '本机助手配置', checkedAt });
}

/** Codex app-server account/rateLimits/read; no thread or model invocation. */
export function codexQuota(result, checkedAt) {
  const snapshot = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
  const windows = [snapshot?.primary, snapshot?.secondary].flatMap(window =>
    finite(window?.usedPercent, 0, 100) ? [{ remainingPercent: 100 - window.usedPercent,
      windowMinutes: window.windowDurationMins,
      resetsAt: finite(window.resetsAt, 0, 253402300799) ? new Date(window.resetsAt * 1000).toISOString() : null }] : []);
  return publicAgentInfo({ quota: { status: 'available', provider: 'openai', windows, credits: snapshot?.credits, checkedAt } }, { source: 'Codex 账户用量' }).quota;
}
