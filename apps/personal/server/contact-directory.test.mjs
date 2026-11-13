import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryContacts, savedContacts, canStartContactChat } from '../src/contact-directory.mjs';

test('directory includes discovered agents while chat adoption remains explicit', () => {
  const contacts = Object.freeze([Object.freeze({ id: 'found', added: false }), Object.freeze({ id: 'saved', added: true }), Object.freeze({ id: 'remote' })]);
  assert.deepEqual(directoryContacts(contacts).map(c => c.id), ['found', 'saved', 'remote']);
  assert.deepEqual(savedContacts(contacts).map(c => c.id), ['saved', 'remote']);
  assert.equal(contacts[0].added, false);
});
test('guest and legacy group identities stay out of the personal directory', () => {
  const contacts = [{ id: 'guest', externalGuest: true, added: true }, { id: 'legacy', groupLegacy: true }, { id: 'own', added: false }];
  assert.deepEqual(directoryContacts(contacts).map(c => c.id), ['own']);
});
test('unavailable directory entries cannot start chat, while reconnect and login flows remain available', () => {
  assert.equal(canStartContactChat({ kind: 'agent', availability: 'unsupported' }), false);
  assert.equal(canStartContactChat({ kind: 'agent', availability: 'not_installed' }), false);
  assert.equal(canStartContactChat({ kind: 'agent', availability: 'ready' }), true);
  assert.equal(canStartContactChat({ kind: 'agent', availability: 'login_required' }), true);
  assert.equal(canStartContactChat({ kind: 'agent', availability: 'disconnected' }), true);
  assert.equal(canStartContactChat({ kind: 'human' }), true);
});
