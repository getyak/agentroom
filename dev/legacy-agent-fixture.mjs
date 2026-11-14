// Seed only newly-created synthetic acceptance directories to exercise legacy
// address books. Production discovery leaves new system contacts unadopted.
import { PersonalStore } from '../apps/personal/server/store.mjs';
export function seedLegacyAgentContacts(dataDir) {
  const store = new PersonalStore(dataDir);
  try {
    store.put('setting', { id: 'workspace-onboarding', completed: true });
    for (const [id, name] of [['codex', 'Codex'], ['claude', 'Claude Code'], ['pi', 'Pi'], ['gemini', 'Gemini CLI'], ['opencode', 'OpenCode']]) {
      store.put('contact', { id: `agent_${id}`, kind: 'agent', name, handle: id, description: '', instructions: '',
        color: 'blue', version: 1, discovered: true, binding: { type: 'local', localAgentId: id }, createdAt: new Date().toISOString() });
    }
  } finally { store.close(); }
}
