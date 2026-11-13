# Nango and group MCP implementation plan

> For agentic workers: use superpowers:subagent-driven-development for bounded independent modules, then independently review the integrated branch. The owner already authorized implementation in this chat.

**Goal:** Let local chat agents discover and request scoped MCP actions, with Nango session setup and visible group controls.

**Architecture:** Two small broker tools prepare existing MCP worker runs; Decisions remains the only external dispatch gate. Versioned per-connection access settings bind agents, conversations, tools, and accepted identities. Nango creates a pinned short-lived runtime session from a backend-held credential.

**Tech stack:** Existing Node ESM/SQLite/vault, ToolSessions, React/TypeScript/Electron IPC; no new dependencies.

**Spec:** ../specs/2026-11-14-nango-group-mcp-design.md

## Global constraints

- Keep credentials out of models, SQLite plaintext, logs and public API responses.
- No global CLI configuration changes, no new Docker stack, preserve real user data.
- Codex/Claude/Pi are supported local executors; remote services retain their own tools.
- An MCP request creates an approval, never proof of execution.
- New scopes default disabled; changing scope/identity prevents old dispatch.
- Nango sessions pin exactly the selected integration/connection, expire in 1h, and disable proxy and dynamic connection creation.

## Review focus

- Removing/readding a group member must invalidate older requests despite identical contact IDs.
- Connection renewal and same-URL credential replacement cannot retain approvals.
- Concurrent broker requests must remain independently idempotent and bounded.
- Unknown remote effects and process restart must not replay writes.
- Tool catalogs can paginate, repeat cursors or contain hostile schema/description data.

### Task 1: Scoped MCP discovery and requests

Files: new server/mcp-access.mjs and mcp-access.test.mjs; modify runtime.mjs, index.mjs, collaboration-runtime.mjs.

Interfaces: `MCPAccess(store, {discover, notify, kick})`; `read()`, `save(connectionId, input)`, `search(context,args)`, `request(context,args,callId)`, `assertRequest(thread,run)`, and `tools` broker schemas. Context contains trusted threadId/runId. Request returns child runId, state and explicit no-execution status.

- [x] Add failing tests for scope filtering, request-without-dispatch, identity/membership/revocation, call ID conflict and pagination.
- [x] Implement validated versioned settings, discover-before-request binding and immutable child runs.
- [x] Hook broker session multiplexing and MCP worker preflight/claim checks; run affected suites.

### Task 2: Nango scoped session connection

Files: new server/nango.mjs and nango.test.mjs; assemble fixed POST connect/renew routes in index.mjs.

Interfaces: `NangoConnections(store, {fetch, saveConnection})`; async `connect(input)`, `renew(connectionId,input)`, `disconnect(connectionId)`. Input has baseUrl, apiKey, integrationId, connectionId, optional toolNames and clientId. Public output uses existing publicConnection with nango expiration metadata. Coordinator may adapt method names while preserving behavior.

- [x] Add failing synthetic HTTP tests checking pinned tenant and secret isolation, bad origin/session response, failures and explicit renewal.
- [x] Implement bounded authenticated requests, vault binding, expiration and cleanup.
- [x] Wire fixed owner routes and readback. Run Nango and integration tests.

### Task 3: Claude broker and user controls

Files: local-agents.mjs/tests, Connections.tsx, new MCPAccess.tsx, types.ts, ConversationDetails.tsx/Messenger.tsx and shared/personal-api.ts/tests.

- [x] Cover Claude strict MCP args with shell/global MCP disabled.
- [x] Add Nango setup form and scoped agent/chat/tool settings; show expiration and explicit renewal.
- [x] Add conversation entry and IPC whitelist, document test IDs/API and trust path.
- [ ] Typecheck/build and browser-test connect, save, reopen, revoke and narrow-screen controls.

### Task 4: Integrated verification and delivery

- [ ] Run personal host tests and affected desktop/dev suites; distinguish skipped platform/provider tests.
- [ ] Independently review complete diff; fix confirmed P0/P1 and material correctness findings.
- [ ] Create linked PR, await current-head CI, merge only when gates pass; read back main CI.
- [ ] Record real Nango account acceptance separately; keep issue open if credentials/provider acceptance is unavailable.

## Execution ledger

- Repository origin/main fetched at 2b37aed; isolated worktree created; historical checkout preserved.
- Resources checked: disk >10 GiB; swap warning means bounded host work and reuse dependencies/build outputs.
- Wabi static structure reviewed at installed 0.1.31; server-side scope rules remain unverified.

- Ruling: add per-chat agent overrides instead of editing the connection default from chat details; this prevents changes in one group from granting agents access in other selected groups.
- Core scope/request tests: 13 passed. Personal full suite before last bounded scope refinement: 353 passed, 1 platform skipped.
- Nango module: 16 tests passed after independent P1/P2 fixes; no remote account call made.
- Browser: 6 journeys passed after correcting acceptance locators and matching proactive version-conflict UI.
- Local build: core artifact symlink needed dependency resolution sibling; fixed local artifact link only. Desktop copied-module smoke initially caught omitted new modules; packaging watch/copy lists updated.
- Dev test launch initially failed on generated-directory symlinks appearing as untracked files; local git exclude now covers generated outputs. Recheck: 38 passed, 1 platform skipped.

- Final review: three P1 issues reproduced and fixed: Claude safe-mode disabled MCP, stale scopes blocked disabling, and concurrent session/catalog/handshake identity changes. Real Claude init-only probe connected exactly mcp_search/mcp_request with zero user messages/inference.
- P2 follow-ups: per-chat defaults filter to actual members; unconfirmed remote revocation remains visible; Nango staging journals recover interrupted installs; child retry now directs a fresh discovery request; service search paginates and parent catalogs are released.
- Real Nango account acceptance is pending: local service is reachable, but its credential-manager login is unavailable. No real provider connection was created or changed.

- Independent re-review: all original P1 and lifecycle P2 findings closed after atomic Nango rotation receipts, pending-revocation journals, explicit local recovery retirement, and orphan-disconnect recovery. Final API/IPC wiring included with native acceptance script.
- Latest whole-host regression before last recovery retirement wiring: 370 passed, 1 platform skipped; Nango module latest 29 passed. Eight browser cases passed before adding explicit recovery retirement as the ninth case.
