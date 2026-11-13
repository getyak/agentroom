# CC Switch capability discovery implementation plan

> Execute inline under the user's request to design and directly improve; independently review the final branch.

**Goal:** Make existing local CC Switch extensions visible without changing their configuration.

**Architecture:** A bounded server-only SQLite metadata reader adds `ccSwitch` to the existing integrations projection. A collapsed settings component presents client summaries and extension names.

**Tech stack:** Node SQLite, React, TypeScript; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-14-cc-switch-agent-capabilities-design.md`.

## Constraints and review focus

Only fixed home-relative file access; no secret columns, external commands, model calls or configuration writes. Missing columns are unknown. Queries use a single read transaction, short lock wait and ordinary table allowlist. Synthetic discovery must not read the real home. Existing IPC and runtime permissions stay unchanged.

## Tasks

1. Add `server/cc-switch.test.mjs` with isolated SQLite fixtures: metadata, absent/invalid files, missing columns/tables, views, bounded lists and read-only invariance. Observe failure, then implement `readCcSwitch({home})` in `server/cc-switch.mjs`.
2. Add `ccSwitch` to integrations and refresh responses using injectable `discoverCcSwitch` and `localAgentDeps.home`; synthetic CLI discovery defaults to an absent projection. Add HTTP acceptance for both routes and failure isolation.
3. Add shared TS projection and `CcSwitchInventory.tsx` in Connections. Show unavailable state, per-client configuration counts, named MCP/Skills details, and explanation that these are not AgentRoom execution grants. Extend `docs/api.md`, `docs/clients.md` and `docs/connectors.md`.
4. Run targeted/full personal host tests, typecheck/build, browser wide/narrow/refresh/failure checks and one real read-only sample. Independent review, fix findings, create linked PR and merge only with current applicable gates green. Preserve evidence and clean only task-owned artifacts.
