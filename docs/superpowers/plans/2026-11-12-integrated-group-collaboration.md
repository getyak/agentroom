# Integrated Group Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make account-free sharing, agent coordination and artifacts capabilities of normal group chats.

**Architecture:** Canonical Messenger threads and PersonalWorker runs, with a narrow sharing gateway derived from the existing guest listener. A group tool service uses trusted run identity and current membership/rules, while shared note/activity objects use ArtifactStore. Owner and guest share conversation components.

**Tech Stack:** Existing Node/SQLite, React, ToolSessions, Electron and cloudflared; no new dependencies.

**Spec:** docs/superpowers/specs/2026-11-12-integrated-group-collaboration-design.md

## Global Constraints

- Use thread/contact/message/run as the only new collaboration records; invitation records confer scope, not a second conversation.
- Default 24h/5 guests/30 model executions; 4000-character messages, 12000-character notes, pending queue 20.
- Explicit published persona/context only; strict public Codex 0.163.0/Pi execution, no fallback to owner private configuration.
- Invitation encrypted, session hashes, HttpOnly/SameSite cookies; no bearer secret in model or ordinary tool receipts.
- Owner rule controls publishing; pending invitation reveals no private preview. No irreversible cleanup or account migration.
- Preserve user branch and data; use managed external artifacts and existing dependencies; serial expensive checks on shared Mac.

## Review Focus

- Owner's ordinary message route in a shared group must not reintroduce private persona, memories or pre-publication history.
- Concurrent membership/policy/artifact changes must invalidate stale tool authority and prevent late disclosure.
- A guest must not forge an owner, approve an invitation, discover private contacts or expand artifact paths.
- Replayed tool calls, restart and migration must not duplicate groups, model runs or artifact edits.
- Public history for a new guest must include only explicitly published material, including exact artifact revisions and actor attribution.

### Task 1: Canonical shared groups and narrow gateway

Files: create `apps/personal/server/group-sharing.mjs`, `group-sharing.test.mjs`; modify `messenger.mjs`, `store.mjs`, `index.mjs`, `play-integration.test.mjs` and copied runtime module list.

Interfaces: `GroupSharing(store,{messenger,creation,validateInput,kick,notify,worker,...guestOptions})` supplies `prepare(threadId,body)`, `publish(threadId,body)`, `info(threadId,viewerId)`, `join(body)`, `send(threadId,actorId,body)`, `prepareRun(thread,input,body,actorId)`, `contextForRun(thread,run)` and `canPublishRun(thread,run)`. Guest HTTP remains separate from private owner API. Legacy room capability maps to `threadId` and is migrated idempotently.

- [x] Add HTTP tests: accepted visitor creates a real scoped contact/member, posts exactly one canonical message/run, owner sees same thread; no old history/private identity; pending shares cannot preview; close/remove/idempotence/quotas and legacy migration.
- [x] Run `node --test apps/personal/server/group-sharing.test.mjs`; expect missing module.
- [x] Implement service, trusted owner routes `/api/chats/:id/sharing` and existing scoped invite copy compatibility, canonical actor-aware Messenger hook and run snapshot fields.
- [x] Run focused sharing/messenger/integration tests; commit with passing evidence.

### Task 2: Agent group tools, rules and scoped runtime

Files: create `group-tools.mjs`, `group-tools.test.mjs`; modify `creation-service.mjs`, `collaboration-runtime.mjs`, `runtime.mjs`, `group-sharing.mjs`, `index.mjs` and native route allowlist.

Interfaces: `GroupTools(sharing)` provides `tools(context)`, `call(context,name,args,callId)` and `validate(context,name,args)`; tools `group_contacts/create/info/add_agents/invite`. Owner API `/api/group-rules` is versioned. `creation.tools(context)` merges permitted tools and disables cached dynamic group info. Shared runs use accepted public context and strict execution/auth session.

- [x] Write broker tests: owner agent creates normal group, selects contacts and prepares invitation; replay does not create twice; stale member version has no mutation; guest agent cannot access private contacts/create/share; rules and depth budget limit expansion.
- [x] Run focused tests; expect tool availability/snapshot failures.
- [x] Wire tools and worker public-context execution, live roster/status, source-chat group cards and membership revalidation; forbid unrestricted fallback for shared runs.
- [x] Run tool/context/membership and existing native-tool tests; commit.

### Task 3: Shared notes and activities as real artifacts

Files: create `group-artifacts.mjs`, `group-artifacts.test.mjs`; modify group service/tools, artifact projections and existing artifact access checks.

Interfaces: `GroupArtifacts(sharing,creation)` supplies `create(threadId,actor,input)`, `list(threadId,actor)`, `read(threadId,actor,artifactId)`, `editNote(threadId,actor,input)` and `act(threadId,actor,input)`. Notes use fixed `note.md` + current revision/hash; activities use fixed versioned `activity.json`, bounded choices and actor-scoped state. Permission check precedes internal owner artifact capability, contribution identity comes from actor.

- [x] Tests: note appears in real Library, immutable revisions and CAS conflict; correct guest contribution; no cross-group or unpublished version access; duplicate votes/answers and two guest synchronization; no arbitrary paths or identity fields; migrated old notes preserved.
- [x] Run tests; expect missing module.
- [x] Implement bounded artifact creation/read/edit/actions, public revision manifests and migration hook, tools available only to their scoped group.
- [x] Run artifact + group + creation regressions; commit.

### Task 4: One conversation experience and release

Files: create `GroupCollaboration.tsx`, `GroupArtifacts.tsx`, shared conversation components and browser acceptance harness; modify `Messenger.tsx`, `MessengerNavigation.tsx`, `ConversationTimeline.tsx`, `guest.tsx`, types/CSS, native packaging and contracts.

Interfaces: shared conversation view accepts canonical public `Thread`, scoped contacts, viewerId and action transport. Owner group controls cover roster, sharing rules/approval/copy/revoke and group artifacts. Guest is the same chat with narrow capabilities. Source-chat group cards open actual thread IDs. Remove standalone gallery/navigation from product entry.

- [x] Add browser tests before UI changes: normal group in list, same owner/guest timeline, membership statuses, shared artifacts, two guests/agents, 390px, reconnect and draft preservation; expect absent integrated controls.
- [x] Implement UI, notes/activity templates and invitation acceptance using canonical group state; preserve legacy invitation routing.
- [ ] Update docs/api, clients, architecture and user flow; run applicable personal/desktop/dev suites and typechecks/builds.
- [ ] Perform independent whole-branch review; fix Critical/Important with regressions. Run actual scoped CLI and native package acceptance, bounded public check, PR/CI/merge/install with preserved data. Record unavailable tracking or network evidence honestly.
