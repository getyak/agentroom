# Assistant management implementation plan

**Goal:** Discover and manage native/ACP assistants and add them as contacts while preserving existing accounts and chats.
**Architecture:** A bounded cached catalog/managed installer module, an ACP transport behind existing local execution, and a shared Add Contact management UI. Root integration owns API, persisted snapshots, native packaging and documentation.
**Spec:** ../specs/2026-11-14-assistant-management-design.md
**Tech stack:** Node ESM, SQLite existing store, React 19, TypeScript, Electron.

## Global constraints

Preserve existing vendor account/config files, contact IDs and chat data. Metadata refresh never installs or invokes models. Install only explicit pinned catalog actions into versioned owned directories. Existing accepted runs keep their executable. Unknown auth stays unknown. Tests use isolated fixtures and never call real models unless explicitly scoped acceptance.

## Review focus

Registry failure/invalid metadata, untrusted distribution coordinates, installation replay/concurrency/restart, active-run version pinning, synthetic test isolation and leaked resources, ACP cancellation/tool requests, missing/unknown authentication, native packaging copied modules, UI failure drafts and responsive navigation.

### Task 1: Catalog and lifecycle module
Files: new `apps/personal/server/assistant-manager.mjs`, helpers prefixed `assistant-`, associated node tests. Implement the exact spec class/entry/operation contract. Tests cover cache refresh/fallback, native vs adapter version separation, offline state, safe explicit installs, idempotency, job serialization, snapshot authority and recovery. No changes to API/UI/shared files. Independently scoped module can be implemented while root builds ACP transport.

### Task 2: ACP transport and integration
Files: new `apps/personal/server/acp-client.mjs` + tests, modify local-agents, agent-profiles, messenger, index, runtime and desktop build/preload contracts as required. Test initialize/new/prompt, streaming, permission denial, cancellation and failed processes with synthetic stdio agents. Merge only installed supported manager entries into inventory; keep native helpers intact; persist exact managed launch coordinates in execution snapshots.

### Task 3: Add Contact experience
Files: new `apps/personal/src/AssistantManagement.tsx`, `assistant-management.css` and types; integrate into LocalAgentPicker without changing its props/legacy IDs. Two tabs, search, freshness, version/source metadata, install/update job progress and retries. Existing identity, customize and remote connection actions remain. Browser test new flows with synthetic API responses and viewports.

### Task 4: Verification and delivery
Update docs/api/design/clients/testing and native module copies. Run affected unit/type/browser tests, isolated real installed CLI handshakes where possible without model calls, independent whole-branch review, CI, PR linked to Linear, merge after gates, package and validate exact merged build. Preserve active normal app/approvals and recovery bundle while updating installed files. Save formal evidence then remove completed task artifacts/worktree.
