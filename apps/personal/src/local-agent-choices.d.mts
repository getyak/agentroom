import type { Contact, Integrations, LocalAgent } from './types';
export type LocalAgentChoice = {
  agent: LocalAgent; contact: Contact | undefined; state: 'ready' | 'setup' | 'unsupported';
  status: string; added: boolean; reason: string; recent: number;
};
export function localAgentChoices(inventory: Pick<Integrations, 'agents'> | null, contacts: readonly Contact[], recentContactIds?: readonly string[]): LocalAgentChoice[];
