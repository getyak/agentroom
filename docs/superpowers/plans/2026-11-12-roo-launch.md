# Roo and public release implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task, followed by an independent branch review.

**Goal:** Publish AgentRoom under getyak with a persistent first-conversation guide.

**Architecture:** A small guide module owns deterministic selection, idempotent seeding and safe context projection. Existing Messenger/worker handle chat; an inline component routes to the existing discovery/contact/connection flows.

**Tech Stack:** Electron, React 19, TypeScript, Node SQLite, existing pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-11-12-roo-launch-design.md`.

## Global constraints

- No new runtime dependency; preserve existing data and running applications.
- No automatic model call on launch or provider switching after selection.
- Existing action/contact approvals remain in force; no imported Raft implementation.
- Managed DataSSD artifacts, serial builds, fixed desktop acceptance launcher.

## Review focus

- Fresh workspaces versus already populated and deliberately reopened onboarding.
- Installed but unauthenticated/unsupported or invalid-model assistants.
- Concurrent bootstrap/contact reads and restart without duplicate seed data.
- Accepted guide context excludes private messages and credentials.
- Missing backend still permits setup; release archive identifies signing limits.

### Task 1: Durable guide

Files: new `apps/personal/server/workspace-guide.mjs` and `.test.mjs`; modify `index.mjs`, `messenger.mjs`, `runtime.mjs` and desktop runtime copy list.

- [x] Write and run failing tests for selection, unavailable backend, persistence, old profiles and safe context.
- [x] Implement `WorkspaceGuide.sync(detected)`, `state()` and accepted run context through Messenger.
- [x] Run focused backend tests and existing workspace/conversation tests.

### Task 2: First conversation

Files: new `apps/personal/src/WorkspaceGuide.tsx` and CSS; modify `Messenger.tsx`, `ContactAvatar.tsx`, `types.ts`, existing acceptance scripts and client contracts.

- [x] Auto-open the returned guide thread only at first entry/reopen, preserving explicit navigation.
- [x] Render mascot and inline actions, optional display name and completion without forcing a new-chat modal.
- [x] Verify guide actions, reload, existing profiles, missing backend and narrow/dark rendering.

### Task 3: Public alpha

Files: README translations, release notes and reproducible macOS archive command/workflow as needed.

- [ ] Link issue and PR, run independent review and applicable CI, fix confirmed defects.
- [ ] Merge, build the clean merged revision, package and run isolated native acceptance.
- [ ] Upload macOS archive/checksum/receipt, verify public release and update Linear only after acceptance.
