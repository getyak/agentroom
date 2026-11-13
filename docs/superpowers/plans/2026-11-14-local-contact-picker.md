# Local Contact Picker Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an existing local assistant and open its chat in one click.

**Architecture:** Reuse LocalAgentPicker, contacts/local adoption and Messenger.startChat. A small pure projection orders actual inventory and contact facts. Every add entry opens the same picker; the existing ContactEditor remains the secondary identity editor.

**Tech Stack:** React 19, strict TypeScript, native IPC, Node test runner and Playwright.

**Spec:** docs/superpowers/specs/2026-11-14-local-contact-picker-design.md

## Global Constraints

- Preserve existing stable contacts, identities, configuration and chats.
- Discovery never calls a model. Login configuration is not verified execution.
- Use existing semantic colors, system typography and documented test IDs.
- No added dependencies, network listeners, account switching or data migration.

## Review Focus

- Configuration failure must win over a detected login when choosing an action.
- Lost adoption responses must not generate a fresh request on retry.
- Adoption succeeds but opening chat fails: preserve the saved relationship and retry chat.
- Refresh failure must leave previous inventory visible and avoid acting on stale facts.
- Closing identity disclosures must retain existing custom settings.

### Task 1: Local assistant choices and one-click action

**Files:** src/local-agent-choices.mjs and .d.mts; src/LocalAgentPicker.tsx; src/local-agent-picker.css; server/local-agent-choices.test.mjs under apps/personal.

**Interfaces:** localAgentChoices(inventory, contacts, recentContactIds) returns ordered installed candidates with contact, state and truthful status; LocalAgentPicker consumes optional recentContactIds and secondary role/human callbacks.

- [x] Write and run choice tests for ready/configuration/login/unsupported states, deterministic ordering, recent activity and no input mutation. Expected: red before implementation, green after.
- [x] Replace checkbox/batch action with per-row adopt-and-open, retained idempotency and saved-contact retry; keep snapshots on refresh.
- [x] Run node --test apps/personal/server/local-agent-choices.test.mjs. Expected: all pass.

### Task 2: Shared entry and identity disclosure

**Files:** apps/personal/src/Messenger.tsx, MessengerDialogs.tsx and local-agent-picker.css.

**Interfaces:** every Add Contact entry opens LocalAgentPicker; onCustomize(kind) opens ContactEditor with initialKind.

- [x] Connect all add entries and secondary actions; keep the current chat unread while the picker covers it.
- [x] Move assistant selection first, expose name/instructions, disclose appearance and advanced fields without resetting values.
- [x] Run personal and desktop typechecks. Expected: pass.

### Task 3: Acceptance and delivery

**Files:** dev/local-agent-cards-acceptance.mjs, dev/messenger-acceptance.mjs, docs/clients.md and docs/personal/messenger.md.

- [x] Exercise one-click flow, duplicate/reload preservation, request failures, login/configuration/setup and role/human secondary paths; inspect light/dark and narrow screenshots.
- [x] Run personal and desktop host suites and affected browser/native journeys serially. Expected: pass; label synthetic evidence.
- [ ] Delivery gate: independent review completed; create linked PR, await exact-head CI/gates, merge and verify merge checks. Close GET-533 after acceptance.

## Local evidence

Personal tests: 328 passed, 1 skipped. Desktop tests: 246 passed. Dev tests: 38 passed, 1 skipped. Browser: local picker 9 groups, Messenger 18 checks, Agent settings 8 groups and live conversation 9 checks passed. Isolated Electron picker: 5 groups passed. The independent reviewer found one P2 nested disclosure validation issue; a browser test reproduced it before the fix and passed after expanding all ancestor disclosures. All CLI/model and account fixtures in these journeys are synthetic; this does not establish real provider execution.
