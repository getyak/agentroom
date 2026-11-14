import { expect, it } from 'vitest';
import { GroupRequestError, definiteGroupRejection } from '../../personal/src/group-errors';
import { restoreGroupDraft } from '../../personal/src/group-draft';
it('preserves an unconfirmed exact envelope independently from a newer draft after reload', () => {
  const pending = { text: 'original', replyTo: 'msg_1', clientId: 'stable_client_123' };
  expect(restoreGroupDraft(JSON.stringify({ version: 1, text: 'new draft', pending, replyTo: 'msg_2' }))).toEqual({ version: 1, text: 'new draft', pending, replyTo: 'msg_2' });
  expect(restoreGroupDraft('legacy plain text').text).toBe('legacy plain text');
  expect(restoreGroupDraft(JSON.stringify({ version: 1, text: 'ok', pending: { ...pending, actorId: 'self' } })).pending).toBeNull();
});

it('does not replay another actor envelope and distinguishes definitive rejections from uncertain transport', () => {
  const raw = JSON.stringify({ version: 1, actorId: 'guest_a', text: 'private draft', pending: { text: 'old actor message', clientId: 'stable_client_123' } });
  expect(restoreGroupDraft(raw, 'guest_b').pending).toBeNull(); expect(restoreGroupDraft(raw, 'guest_b').text).toBe('');
  expect(definiteGroupRejection(new GroupRequestError('unavailable', 409, 'agent_unavailable'))).toBe(true);
  expect(definiteGroupRejection(new GroupRequestError('unknown', 500))).toBe(false);
  expect(definiteGroupRejection(new TypeError('network'))).toBe(false);
});
