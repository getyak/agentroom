# Guest Playrooms Implementation Plan

> 历史设计。GET-547 已按新 Roo 身份、统一审批和自动成员拼图适配；当前行为以 [迁移台账](../../migrations/agentstudio-merged-features.md)、API 与客户端合同为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship account-free, scoped browser rooms with digital-twin, travel, and co-creation examples.

**Architecture:** A separate guest listener exposes only published room state. The trusted personal API owns room creation, invitation reveal, revocation and network lifecycle. A restricted local executor uses the existing ToolSessions boundary.

**Tech Stack:** Node 22 SQLite, React 19, existing Vite / Electron, cloudflared.

**Spec:** docs/superpowers/specs/2026-11-12-guest-playrooms-design.md

## Global Constraints

- Preserve personal loopback / IPC and device-sharing isolation; no new dependencies.
- Default 24 hours, 5 guests, 30 Agent turns; 4000-character messages, 12000-character notes / replies.
- Publish only explicitly entered context and persona; Codex / Pi strict tools only.
- Store invitation encrypted, session secrets hashed; fragment invitation, HttpOnly SameSite cookie.
- Fail closed on expired / revoked / removed sessions and unsupported controlled CLI.
- Cloudflare Quick Tunnel is temporary; use polling, no SSE.

## Review Focus

- Leaked public URL must not expose owner APIs or unrelated room state.
- Concurrent join and duplicate sends must not bypass limits or execute twice.
- Revocation during execution must suppress output even if a model ignores cancellation.
- Browser reload / host restart must preserve work without silently replaying a model request.
- Nickname, Markdown, model output and stale note edits must remain untrusted and cannot impersonate owner.

### Task 1: Persistent room and scoped guest HTTP

Files: create `apps/personal/server/playrooms.mjs`, `playrooms.test.mjs`.
Interfaces: `Playrooms(store, options)`, `create(body, contact)`, `invitation(id)`, `owner(id)`, `action(id, actor, body)`, `listen()`, `close()`, `handle(request,response)`; private kind `play_room`, `play_session`, `play_job`.

- [ ] Write real HTTP failing tests for invitation preview / nickname acceptance, old published context, distinct identities, foreign-room rejection, duplicate body conflict, quotas, CAS notes, remove / close / expiry, failed and late runs, restart recovery, Host / Origin checks, and private route denial.
- [ ] Run `node --test apps/personal/server/playrooms.test.mjs`; expected missing module failure.
- [ ] Implement transactional state and allowlisted projections; injected executor only at this layer.
- [ ] Run the same test file; expected all pass. Commit task.

### Task 2: Restricted executor and trusted host integration

Files: create `play-executor.mjs`, `play-network.mjs` and their tests; modify `index.mjs`, Electron personal-api allowlist and config copying.
Interfaces: `createPlayExecutor(store, deps)` returns `{execute(context,signal),close()}`; `PlayNetwork(rooms,options)` returns `{status(),start(),stop()}`. Owner routes `/api/playrooms`, `/api/playrooms/:id`, `/:id/invite`, `/:id/actions`, `/api/play-network`.

- [ ] Write failing tests pinning tool-free / room-read-only execution and trusted API whitelist; test tunnel URL validation, exit handling and owned cleanup using synthetic child.
- [ ] Run tests; expected missing module / routes failure.
- [ ] Connect scoped executor, room lifecycle and suspend / close; add packaged runtime files. Start network only on explicit owner command.
- [ ] Run focused tests plus personal server suite; expected pass. Commit task.

### Task 3: Playful owner and guest UI

Files: create `Playrooms.tsx`, `PlayRoom.tsx`, `play-types.ts`, `playrooms.css`, `guest.tsx`, guest HTML entries; modify Messenger navigation and Vite / Electron entries.
Interfaces: shared `PlayRoomView` receives public room plus action transport; owner manager uses trusted `api`, guest uses same-origin narrow API only.

- [ ] Add browser acceptance harness with two independent browser contexts, real synthetic server and all three case templates. Before UI implementation expected missing play entry / invitation screen.
- [ ] Implement case selection, explicit published context preview, nickname accept, messages, travel voting, checklist, CAS notes / export, owner invite / revoke / remove, useful failures and reduced motion.
- [ ] Verify 1280px and 390px screenshots, keyboard submission and live two-guest changes. Run personal / desktop typechecks and affected tests; expected pass. Commit task.

### Task 4: Native and public acceptance, review and delivery

Files: docs/api.md, docs/clients.md, docs/architecture.md, docs/personal/guest-playrooms.md; acceptance report under local evidence.

- [ ] Build shared guest assets into standalone and Electron output, verify packaged IPC can create and revoke a room.
- [ ] Run one actual local model conversation and bounded anonymous HTTPS test with synthetic data. Clearly separate any unavailable network / model evidence.
- [ ] Run applicable full suites and independent whole-branch security review, fix important findings with failing regression first.
- [ ] Create linked tracking issue if Linear recovers; otherwise preserve failure and pending text. Create PR, wait CI, merge when gates pass; install and read back native acceptance. Preserve evidence and close only owned temporary resources.
