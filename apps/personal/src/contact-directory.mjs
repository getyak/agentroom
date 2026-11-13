export function directoryContacts(contacts) {
  return contacts.filter(contact => !contact.externalGuest && !contact.groupLegacy);
}
export function savedContacts(contacts) { return directoryContacts(contacts).filter(contact => contact.added !== false); }
export function canStartContactChat(contact) { return contact.kind !== 'agent' || !['unsupported', 'not_installed'].includes(contact.availability); }
