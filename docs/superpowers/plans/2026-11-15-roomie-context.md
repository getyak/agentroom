# Roomie Context Recommendations Implementation Plan

> Implement in the current session with superpowers:executing-plans; independently review the completed branch.

**Goal:** Generate useful recommendations from tool-observed group and environment facts, without canned fallback roles.
**Architecture:** Reuse Roomie jobs, PersonalWorker and its restricted CLI transport. Preserve ChatTools membership/provenance checks and separate metadata discovery from model consent.
**Tech Stack:** Node ESM, SQLite, React/TypeScript; no new dependencies.
**Spec:** `docs/superpowers/specs/2026-11-15-roomie-context-design.md`

## Constraints and review focus

No synthetic owner chat messages, automatic provider switch or group mutations. A disabled/re-enabled grant, membership change, public-room transition or changed source binding invalidates in-flight evidence. Empty output is silent; failure is visible and never replaced with a role template. Unchanged context and cooldown must suppress repeated calls.

1. Add failing tests for no fallback, empty suggestions, real tool reads, evidence validation, private/group boundaries and revocation.
2. Add `roomie-context.mjs`: bounded tool projections, accepted-source records and publication checks. Extend `roomie-executor.mjs` with per-job scoped tools.
3. Extend `roomie.mjs` and `index.mjs`: change-driven, consented queued observations, cooldown, stale-source and identity checks, model-only output and provenance.
4. Expose the separate toggle, evidence and sampling time in `RoomieChat.tsx` / `roomie-types.ts`. Update contracts and the desktop copied-module manifest.
5. Run focused and personal regression tests, typecheck/build and browser acceptance. Obtain independent review, fix confirmed defects, create linked PR and use current CI results for merge/issue state.

## Execution ledger

- Baseline: Roomie and Roo unified tests, 19 passed.
- Ruling: Only groups jointly visible to owner and Roo expose messages; directory discovery alone grants no transcript access. This preserves the existing product contract.
- Implementation uses an isolated worktree on the latest canonical main.

- Model-only planner and change-driven observer implemented; tool reads and advice preserve ChatTools provenance.
- Independent review found and verified fixes for source edits during final async checks and backend changes during enqueue identity lookup.
- HTTP/worker integration, eight observer regressions, browser source display and real Codex isolated group/tool acceptance passed. Full personal suite: 613 passed, one pre-existing skip before the final three observer tests were added; latest full rerun follows.
