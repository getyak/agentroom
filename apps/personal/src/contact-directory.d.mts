type DirectoryEntry = { added?: boolean; externalGuest?: boolean; groupLegacy?: boolean };
export function directoryContacts<T extends DirectoryEntry>(contacts: readonly T[]): T[];
export function savedContacts<T extends DirectoryEntry>(contacts: readonly T[]): T[];
export function canStartContactChat(contact: { kind: string; availability?: string }): boolean;
