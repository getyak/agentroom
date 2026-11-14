export type GroupEnvelope = { text: string; replyTo?: string; clientId: string };
export type GroupDraft = { version: 1; text: string; replyTo?: string; pending: GroupEnvelope | null };
export function restoreGroupDraft(raw: string | null, actorId?: string): GroupDraft {
  const empty: GroupDraft = { version: 1, text: '', pending: null };
  if (!raw) return empty;
  let value: unknown; try { value = JSON.parse(raw); } catch { return { ...empty, text: raw.slice(0, 4000) }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const saved = value as Record<string, unknown>; if (actorId && saved.actorId !== actorId) return empty;
  const pending = saved.pending as Record<string, unknown> | null;
  const valid = pending && typeof pending === 'object' && !Array.isArray(pending) && Object.keys(pending).every(k => ['text', 'replyTo', 'clientId'].includes(k)) && typeof pending.text === 'string' && pending.text.length <= 4000 && typeof pending.clientId === 'string' && /^[a-zA-Z0-9_-]{8,160}$/.test(pending.clientId) && (pending.replyTo === undefined || typeof pending.replyTo === 'string');
  return { version: 1, text: typeof saved.text === 'string' ? saved.text.slice(0, 4000) : '', ...(typeof saved.replyTo === 'string' ? { replyTo: saved.replyTo } : {}), pending: valid ? { text: pending.text as string, ...(typeof pending.replyTo === 'string' ? { replyTo: pending.replyTo } : {}), clientId: pending.clientId as string } : null };
}
