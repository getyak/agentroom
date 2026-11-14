# Contact conversation context implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Give ordinary contact chats independently owned backend sessions and send only context the backend has not already acknowledged.

**Architecture:** A private session ledger prepares immutable dispatch manifests from the existing authorized context selector. A verified Pi file-session adapter cold-resumes an exact application-owned transcript; the worker commits acknowledgement with publication and preserves unknown attempts. Other adapters retain stateless behavior until separately verified.

**Tech Stack:** Existing Node ESM, SQLite documents/transactions, React/TypeScript, Pi CLI JSONL; no new dependencies or resident process pool.

**Spec:** `docs/superpowers/specs/2026-11-14-contact-conversation-context-design.md` (approved by the user in this chat).

## Global Constraints

- Same CLI roles and different chats have different session handles; profile ownership follows the existing PersonalStore directory.
- Preserve accepted persona/model/transport, membership epochs, source provenance, decisions and unknown-operation barriers.
- No provider fallback, no global CLI history import, no automatic resending after unknown delivery, no new background model calls.
- Session files and handles stay private; only mode/count/byte/receipt summaries cross the UI boundary.
- Default tool sessions get fresh per-run tokens; projects, public/shared groups, coauthoring, goals and legacy tasks remain on existing paths in this delivery.
- Pi is the first adapter because its installed CLI documents an explicit absolute session path; Codex/Claude/ACP/A2A stay compatible until their storage and recovery contracts are verified.
- No automatic summarization or silent truncation; preserve existing hard input/output bounds.

## Review Focus

- A removed/rejoined member or expanded group audience must not inherit an old narrower context (Task 1/3 tests).
- A transcript missing after a possible dispatch is not proof of no send (Task 2/3 tests).
- Tool reads during a silent turn remain dependencies of later outputs (Task 1/3 tests).
- A backend-completed turn followed by local publication failure must not cause a second model request (Task 2/3 tests).
- Profile/model/credential changes must invalidate compatibility without exposing tokens (Task 1/3 tests).

---

### Task 1: Private session ledger and immutable incremental manifests

**Files:** Create `apps/personal/server/conversation-sessions.mjs` and `conversation-sessions.test.mjs`.

**Interfaces:**
- Consumes: `PersonalStore`, `thread`, accepted `run`, authorized `context`, adapter `{id,version,bindingFingerprint}` and dependency validator.
- Produces: `ConversationSessions.prepare({thread,run,context,adapter,canRead}) -> {session,manifest,context}`; `markSending(runId)`, `recordResult(runId,receipt)`, `commit(thread,run)` and `fail(runId)`; `assertCurrent(thread,run,context,canRead)`.
- Public `run.contextDispatch` contains mode, sent/retained message counts, bytes and receipt state only. Private session/input records own paths, content hashes and backend receipt.

- [x] Write tests for two contacts/two chats, only unacknowledged messages/memories, own-output deduplication, same-input immutability, changed source/role/model/member invalidation, cumulative read dependencies, and unknown attempts blocking subsequent turns.
- [x] Run `node --test apps/personal/server/conversation-sessions.test.mjs`; watch the absent behavior fail.
- [x] Implement immutable material manifests; exact message IDs/hashes instead of timestamps; validate all retained source material and membership before reuse. Keep retired generations for recovery.
- [x] Run the ledger tests; expect zero failures. Commit `feat: track independent conversation sessions and incremental inputs`.

### Task 2: Exact Pi file sessions and read-only turn receipts

**Files:** Modify `local-agents.mjs`; create `conversation-pi.mjs`, `conversation-pi.test.mjs`; extend local-agent fixtures/tests.

**Interfaces:**
- Consumes: Task 1 `session` and `manifest`; absolute app-owned session directory/file and run ID.
- Produces: `conversationPiCapability(deps) -> verified capability or null`; `validatePiSession(session, expectedReceipt)`; `inspectPiTurn(session, manifest) -> {state,markdown,receipt}`. `executeLocalAgent` accepts `conversationSession` and returns a private `conversationReceipt` on confirmed completion.
- Exact supported adapter version/CLI path, binding fingerprint and expected transcript identity are checked before a resume. Every invocation retains explicit model/provider/thinking and current native-tool arguments/environment.

- [x] Test explicit file arguments, cold recovery, missing/tampered/symlink session files, provider/model mismatch, incomplete and malformed records, no `--continue`/global lookup, failure without resend and fresh tool-session injection.
- [x] Run `node --test apps/personal/server/conversation-pi.test.mjs apps/personal/server/local-agents.test.mjs`; observe new cases fail.
- [x] Implement bounded private JSONL receipt parsing and version-gated file sessions; use `--session`/`--session-dir` in place of `--no-session` only for a prepared private session. Preserve normal stateless calls.
- [x] Run the adapter tests; expect zero failures. Commit `feat: cold-resume owned Pi conversations with exact receipts`.

### Task 3: Worker integration, recovery, diagnostics and acceptance

**Files:** Modify `runtime.mjs`, `store.mjs`, `decision-views.mjs`, `apps/personal/src/types.ts`, `ConversationDetails.tsx`, desktop runtime copy list, `docs/api.md`, `docs/architecture.md`, `docs/clients.md`, `docs/roadmap.md`; add worker integration tests and a synthetic/live acceptance script.

**Interfaces:**
- Consumes: Task 1 ledger and Task 2 adapter capability/receipts.
- Produces: Existing Messenger replies with an internal bootstrap/delta/rebuild context, inherited read provenance and truthful execution-detail counters; restart recovery can inspect original completed turns without invoking the model.

- [ ] Add integration tests through PersonalWorker/Messenger for bootstrap then delta, independent chats/roles, queued causal messages, group join/rejoin, revoked reads after silence, changed persona/model, final publication checks, completion/save crash window, unknown send cancellation/restart and stateless compatibility.
- [ ] Run new worker tests; observe original full-context dispatch and missing recovery safeguards fail.
- [ ] Integrate at lane execution, snapshot immutable redacted prompt context, carry cumulative read dependencies, acknowledge with final publication/participation transaction, and keep unknown receipts private. Excluded execution types must stay unchanged.
- [ ] Add the public receipt summary type/reading details; package new runtime modules. Update current contracts and an acceptance ledger without claiming unverified adapters.
- [ ] Run all personal-server tests with bounded concurrency, TS typechecks, desktop module-copy build/load and relevant synthetic browser acceptance. Run a real isolated Pi cold-resume/tool-refresh conversation, retaining only synthetic prompts and sanitized measurements as evidence.
- [ ] Independently review the whole branch and fix confirmed P0/P1 issues; run applicable CI on the final pushed head, merge only after passing, then read back merge and Linear completion.
- [ ] Commit `feat: use incremental contact context with safe recovery and diagnostics`.

## Execution rulings

The user explicitly requested implementation and merge after tests, so this plan proceeds inline without another approval round. The coupling between ledger, adapter and worker favors one implementation context plus independent preflight/final review. The approved design's staged rollout remains binding: this delivery enables the verified Pi adapter and common machinery; unsupported adapters are reported as stateless, not falsely enabled.
