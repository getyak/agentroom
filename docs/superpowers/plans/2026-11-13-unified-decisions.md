# Unified Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement GET-531 so supported approvals have one durable decision path, accurate receipts, enforced provider boundaries, and contextual handling in chat.

**Architecture:** A Decisions module in the existing utility owns local request/respond/read rules and dispatch admission. Native provider cards retain a private adapter with its actual authority and recovery contract. Keep SQLite, PersonalWorker, stable thread/decision IDs and HTTP/IPC compatibility; no second executor or generic permission platform.

**Tech Stack:** Node 22 SQLite, TypeScript, React, existing Vitest/browser acceptance.

**Spec:** [Approval architecture design](../specs/2026-11-13-approval-architecture-design.md).

## Global Constraints

- Preserve current IDs, profiles, credentials, accepted runs, ordinary A2A Send and unknown-result fences.
- No real approval choices or provider/account writes during tests. Use isolated fixtures and registered DataSSD artifacts.
- Only actual controlled operations may offer reusable authorization; opaque provider choices never inherit local grants.
- No claim that unsupported CLI/remote per-tool interception is implemented. Capabilities describe current guarantees.
- Human choices, response delivery, execution results and verification are independent facts.
- Honor the host's existing heavy-work pause. Run focused serial tests; full builds/CI on available resources.

## Review Focus

- Provider revisions also change after answering: distinguish observation changes from a new semantic request.
- A provider-side answer does not prove this machine's uncertain answer was accepted.
- Main/utility both enforce original-app-only and scope receipt lookup to the same request generation.
- Dispatch claim is the authority-consumption point; revocation after claim cannot promise a remote rollback.
- A reusable grant must stay bound to precise operation, original conversation/contact, connection identity, tool schema, expiry and usage budget.

## File Structure

- `server/decisions.mjs`: local request/respond/read, private runtime admission, exact operation grants and receipts.
- `server/decision-views.mjs`: pure public capability/status projection, reused by threads and approval list.
- `server/provider-approvals.mjs`: provider-only observation and durable answer transport.
- Desktop `personal-services.ts`, connector types/Grok: main-owned generation and response ledger.
- `runtime.mjs`, `index.mjs`, `messenger.mjs`: integrate the single decision path without new scheduling.
- Shared UI types, DecisionView, ConversationTimeline and Messenger: same request inline and in the inbox.

### Task 1: Provider request generations and truthful receipts

**Files:** provider-approvals.mjs/test; desktop personal-services.ts/test; connector types/Grok/tests.

**Interfaces:** Native cards add an optional stable semantic request generation; raw revision remains the exact response fence. Provider answer receipts retain generation, original revision and choice. original-app-only is an enforced authority field.

- [ ] Add regression tests for answered vs completed/verified; original-app-only even with choices; changed pending content; normal resolved revision; uncertain answer resolved elsewhere; same-card new generation through both ledgers.
- [ ] Run provider and desktop focused tests first and retain the expected failures.
- [ ] Implement provider normalization and host ledger checks without replaying unknown mutations.
- [ ] Run the focused suites and commit the tested provider contract.

### Task 2: Decisions module and controlled dispatch

**Files:** new decisions.mjs/test and decision-views.mjs; runtime.mjs; index.mjs; messenger.mjs; store recovery where necessary.

**Interfaces:** `request(threadId, runId, spec)`, `respond(decisionId, command, trustedActor)`, `read(query)`; private worker seam owns preparation/claim/observations. Existing decision POST shape remains accepted. Public views add request type, authority, capabilities and normalized receipt facts.

- [ ] Add integration tests for version/idempotency, concurrent opposite answers, frozen payload/identity, revoke-before/after-claim, interrupted dispatch and malformed actors.
- [ ] Verify RED before implementing the module, then route existing local approvals through it.
- [ ] Bind precise MCP plans to the discovered tool schema, recheck at dispatch, persist Attempt before I/O, retain unknown on interrupted dispatch.
- [ ] Add explicit reusable MCP authorization: same exact operation in this conversation, at most one hour and ten calls, with revocation; never infer broad task scope from tool annotations. Existing work grants retain their own exact checks.
- [ ] Verify grant reuse, exhaustion, expiry, schema/identity/contact changes, and no automatic provider decisions. Commit after focused suites pass.

### Task 3: Contextual requests and clear user actions

**Files:** UI types; ConversationPanels; ConversationTimeline; Messenger; messenger/styles CSS; desktop presentation/conversation tests.

**Interfaces:** Both surfaces render DecisionView keyed by the same decision ID; the existing command handler handles once/repeat/revoke, no separate chat decision store. Original-app-only shows the real provider action/instruction.

- [ ] Add rendered behavior tests for an inline request, response/execution separation, provider answer controls, and supported reusable authorization/revocation.
- [ ] Observe RED; render cards in their original run or standalone request position, retaining conversation context and source identity.
- [ ] Preserve pending/sending/unknown states across both surfaces and make response actions specific.
- [ ] Run UI typechecks and focused suites, then commit.

### Task 4: Integration, docs and release gates

**Files:** API/client/architecture contracts; focused browser acceptance; this plan status.

- [ ] Run applicable complete backend/desktop suites, typechecks and existing synthetic browser journeys with exact commit evidence.
- [ ] Update current contracts and mark the implemented subset accurately: supported decision paths and bounded exact-operation authorization; new CLI bridges, peer principals and provider protocols remain separate work.
- [ ] Obtain independent whole-branch code review; fix confirmed P0/P1 with regression tests.
- [ ] Open a PR linked to GET-531, pass applicable latest-head CI and merge; close only the implemented and verified task, reading back status.

## Implementation rulings

- The current MCP runtime performs one call per run, while chats can contain multiple tasks. Reusable authorization is labeled explicitly as the same exact operation in this conversation (one hour, ten calls), rather than inventing a broad task identity. Per-operation IDs remain distinct; revocation is available from the originating decision.
- The existing provider observation revision changes with widget status, so it is not the semantic request generation. A source-backed generation plus exact response revision is required at both ledgers.
- The native worktree entry rejected this environment's arguments without creating a worktree. This task uses the established external `agentroom-worktrees` directory on the canonical repository; it does not rewrite legacy remotes.
