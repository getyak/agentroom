# Local assistant discovery, management and ACP

User-approved scope: implement the researched approach directly in AgentRoom, preserve existing account configuration and chat data, improve adding contacts, and keep uninstalled assistants and latest releases discoverable.

## Behavior and boundaries

- Two surfaces within Add Contact: 本机已有 and 发现更多. Search names/descriptions, show installed/latest versions, source/path, connection state, install/update progress, retry and clear next actions. Existing three CLI identities and historical chats retain their IDs and configuration. Unknown auth is shown as unknown, never as verified.
- Builtin native tools: codex, claude, pi, gemini, opencode. Read their existing executables/configuration; do not write vendor account/config files. Latest native versions come from fixed official npm package metadata. Gemini/OpenCode can run through native ACP entrypoints; Codex/Claude/Pi retain existing execution adapters.
- ACP Registry supplies additional agents, distinct from native program releases. Stable registry URL https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json. Refresh at most daily in background, keep bounded validated disk cache and explicit freshness/errors; manual refresh is available. Metadata refresh installs nothing and does not call a model.
- Installs/upgrades are explicit actions. Install pinned versions in `personal/assistants` with atomic active manifests. Existing vendor homes and global PATH remain untouched. Retain old version directories and snapshot the accepted executable for each run so update cannot rewrite an accepted task. No automatic bulk upgrades/uninstalls or vendor credential migration.
- Managed installer supports npm distributions and integrity-verified binary archives/raw executables; unsupported distribution/platform remains visible with a reason. Requests provide only catalog ID/action/clientId, never command/URL. Serialize jobs, persist terminal results, report interruptions on restart, drain/stop owned installers on close. Bound downloads, output, runtime and extraction; reject traversal and symlinks.
- ACP v1 uses newline JSON-RPC over stdio: initialize, independent session/new per accepted run, session/prompt, text updates and cancellation. Capabilities advertise no file/terminal authority. Native permission requests are denied, with an explicit status; AgentRoom tool access only uses existing scoped host tools when compatible. ACP is a cooperative protocol, not an OS sandbox. Do not claim CLI credentials or handshake as real-account execution proof.

## Module contracts

`AssistantManager` in `server/assistant-manager.mjs`, constructed with `{dataDir, home?, env?, fetch?, spawn?, now?, notify?}`. Public methods:
- `snapshot({refresh=false}={}) -> Promise<{checkedAt, source:{status,checkedAt,error?}, entries:AssistantEntry[], operations:AssistantOperation[]}>`.
- `start({agentId, action:'install'|'update', clientId, expectedVersion}) -> Promise<AssistantOperation>`; returns promptly, duplicate clientId/input replays, conflicts reject. expectedVersion must match catalog latestVersion before accepting a new install; a changed catalog returns 409.
- `launch(localAgentId) -> Promise<{command,args,version,protocol:'cli'|'acp',agentId}> | null` resolves server-owned native/system/managed coordinates; no install on launch.
- `close() -> Promise<void>` stops owned jobs only.

AssistantEntry fields: `id`, `localAgentId`, `name`, `description`, `kind:'native'|'acp'`, `installed:boolean`, `installedVersion:string|null`, `latestVersion:string|null`, `updateAvailable:boolean`, `installSupported:boolean`, `source:'system'|'managed'|null`, `path:string|null`, `repository:string|null`, `reason?:string`. Native IDs equal localAgentId; registry IDs use `acp_<registry-id>` consistently. Registry entries may coexist with native tools, clearly labeled ACP adapters.

AssistantOperation fields: `id`, `agentId`, `action`, `state:'queued'|'running'|'succeeded'|'failed'|'interrupted'`, `version:string|null`, `progress:string`, `createdAt`, `updatedAt`, `error?:string`.

HTTP: GET `/api/assistants`; POST `/api/assistants/refresh`; POST `/api/assistants/install` body `{agentId,action,clientId,expectedVersion}`. Existing `/api/integrations` stays compatible and adds only installed supported ACP inventory entries. Existing `/contacts/local` validates against fresh supported inventory, never a frontend command.

## References

- ACP registry format: https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md
- ACP v1: https://agentclientprotocol.com/protocol/v1/initialization and session-setup / prompt-turn / tool-calls / cancellation.
- CC Switch installation lifecycle: https://github.com/farion1231/cc-switch/blob/main/docs/release-notes/v4.0.12-en.md
- Codeman availability probe design: https://github.com/Ark0N/Codeman/blob/master/src/utils/cli-installed-probes.ts

Implementation is original; do not transplant credential handling or session databases from other projects.
