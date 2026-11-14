# Roomie Local CLI Defaults Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in the current session; obtain an independent whole-branch review before delivery.

**Goal:** Automatically bind previously unconfigured Roomie/Roo identities to an eligible local CLI.

**Architecture:** Extend WorkspaceGuide's existing transactional discovery synchronization. Migrate only the legacy Roomie identity and direct-chat routing marker; retain Messenger's existing model display and worker execution.

**Tech Stack:** Node.js, SQLite, node:test.

**Spec:** `docs/superpowers/specs/2026-11-14-roomie-local-harness-design.md`

## Global Constraints

Preserve existing bindings, configuration and conversation IDs. Default order is saved local default, Codex, Claude Code, Pi. Discovery must not invoke a model or change completed onboarding.

## Review Focus

Completed onboarding with no guide state; legacy Roomie with existing history; fixed model compatibility; unavailable backends; explicit saved connections and provider failures.

### Task 1: Repair companion binding and legacy chat routing

**Files:** `apps/personal/server/workspace-guide.mjs`, `apps/personal/server/messenger.mjs`, `apps/personal/server/workspace-guide.test.mjs`.

**Interfaces:** `WorkspaceGuide.sync(detected)` keeps its existing signature; Messenger returns the selected local execution/model facts.

- [x] Add regressions for existing unbound companions, legacy DM dispatch, fixed configuration and preservation of selected backends.
- [x] Run `node --test apps/personal/server/workspace-guide.test.mjs` and confirm the new cases fail.
- [x] Reuse one first-binding helper; upgrade legacy system role/routing inside the transaction before onboarding gating.
- [x] Run guide, Roomie, Messenger, profile and local-adapter suites; then all personal server tests.
- [x] Update API/client/design documentation and review independently.
- [ ] Open a linked PR. Merge only after applicable CI and repository gates pass.

## Execution evidence

Baseline: guide and Roomie tests, 22 passed. User working agreement authorizes native implementation, worktree, Linear, PR and gated merge without a separate approval round.

The initial four regressions failed before implementation. Whole personal-server suite: 555 passed, 1 skipped with a physical external temporary directory; macOS's default `/var` → `/private/var` alias caused 12 pre-existing path assertions in unrelated installation/auth tests on the first attempt. No unrelated product changes were made.

Independent review found one P2 in explicit reopening of legacy-only profiles. Added a failing API regression, reused the original DM/contact for guide state and prevented another introduction; all 16 guide tests pass. The final whole-suite run includes this fix.
