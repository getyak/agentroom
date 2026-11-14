# Roomie Workspace Setup Implementation Plan

> 历史设计。GET-547 已按新 Roo 身份、统一审批和自动成员拼图适配；当前行为以 [迁移台账](../../migrations/agentstudio-merged-features.md)、API 与客户端合同为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship Roomie's persistent first chat, verified local configuration, clickable contact and topic-group recommendations, project/link bindings and guided proactive discovery; merge and install after acceptance.
**Architecture:** A Roomie service owns a durable system conversation and setup proposals in existing SQLite. Model jobs reuse the current hidden onboarding queue and restricted adapters; local discovery and templates work without a model. A dedicated chat renderer displays conversation, contact applications and guided choices. Project access stays within explicit roots and accepted audience snapshots.
**Tech Stack:** Existing Node SQLite, React/TypeScript, Electron fixed IPC, existing CLI/tool-session adapters; no new dependencies.
**Spec:** docs/superpowers/specs/2026-11-13-roomie-workspace-onboarding-design.md plus user's 2026-11-13 approval: chat first, click-to-add, topic groups, and guided ongoing local monitoring.

## Global Constraints

- No unconfirmed provider/account switch, no secret/config-file raw text in model inputs or logs.
- Discovery is bounded local metadata; proactive monitoring is visible, optional and never launches models automatically.
- Actual backend random-challenge verification precedes adopting model-generated roles. No backend retains drafts and connection choices.
- First chat is the honest system configuration assistant even before a model is bound; availability is explicit.
- Preserve existing contact IDs, chats, group policies and original onboarding APIs; new local changes are atomic and idempotent.
- Project roots are explicitly selected, canonical, read-only; no symlink escapes, credential/dotfile harvesting or implicit cwd expansion.
- Use DataSSD managed artifacts, hidden native automation via launchDesktopTest, and independent final review.

## Review Focus

1. Cold start without installed/logged-in CLI still exposes a usable chat and connection options.
2. Reload, double adoption, changed models, interrupted verification and uncertain stops cannot duplicate contacts/groups or silently retry models.
3. Untrusted recommendations cannot invent backend IDs, existing contacts, paths, or a capability grant.
4. Directory symlinks, deleted roots, traversal and group audience changes cannot disclose files beyond the accepted scope.
5. Monitoring cannot launch paid model calls, repeatedly nag dismissed cards, or scan unrelated personal data.

### Task 1: Durable Roomie service and real verification

**Files:** Create server/roomie.mjs, roomie-executor.mjs and roomie.test.mjs under apps/personal; modify server/index.mjs, messenger.mjs and desktop fixed route allowlist.
**Interfaces:** GET /roomie returns {threadId,messages,agents,connections,projects,links,settings,job,recommendations}. POST /roomie/messages {clientId,text,agentId?,configuration?} creates a queued test/planning job for a selected local backend; otherwise saves a deterministic guided reply. POST /roomie/actions {clientId,action,recommendationId?,jobId?,...} accepts explicit fixed actions. Jobs use agent_onboarding hidden threads with roomieJobId and current worker cancellation/recovery.
- [ ] Write tests for no-model first chat, source-safe discovery, verified role adoption, idempotent contact/group application, stale configuration and interrupted jobs; run RED.
- [ ] Implement service and restricted executor. A system Roomie contact is clearly unavailable as a model until bound. Validate model JSON against bounded known source/backend IDs. Use existing queue and stop barriers.
- [ ] Run focused tests GREEN and the personal suite; commit.

### Task 2: Real projects and links

**Files:** Create server/project-resources.mjs and tests; update creation-service/tool definitions/runtime snapshots; desktop project chooser IPC.
**Interfaces:** POST /roomie/projects {clientId,path}; POST /roomie/links {clientId,url,label?}; native chooseProject() performs host-owned folder selection then registers it. Applied contacts/groups receive project resource IDs; each accepted run freezes project/audience scope. Fixed project_list/project_read tools return bounded safe data from selected roots.
- [ ] Write RED tests for traversal, symlink escape, moved roots, file size/secrets exclusions, group audience and accepted project snapshot.
- [ ] Implement canonical root authorization and resource bindings; wire project read tools only for compatible controlled tool-session backends.
- [ ] Run project and impacted runtime/tool tests GREEN; commit.

### Task 3: Chat-first Roomie and guided proactive cards

**Files:** Create src/RoomieChat.tsx, roomie-types.ts and roomie.css; modify Messenger.tsx, types.ts and relevant settings/contract docs.
**Interfaces:** The persistent Roomie conversation opens on fresh entry and from its sidebar/contact row. Chat actions call the fixed endpoints from Tasks 1–2. Contact applications are independently adoptable, existing contacts reusable, topic groups creatable by explicit choice or the owner's direct chat instruction. Monitoring is an explicit local-only toggle; configuration changes refresh deterministic cards without model invocation.
- [ ] Add browser acceptance assertions (test IDs only) for first input, goal choices, contacts, groups, projects, restart, missing model and narrow layout; observe RED.
- [ ] Implement conversation with progressive guidance, inline cards, backend/model details, retry/cancel, connection settings entry, directory and link controls, monitor choice and persistent readback.
- [ ] Run typecheck and browser acceptance GREEN; commit.

### Task 4: Acceptance, review, landing and installation

**Files:** dev/roomie-acceptance.mjs, docs/personal/roomie.md, updated API/client/architecture/roadmap contracts.
- [ ] Run host suites, browser/390px acceptance, real configured CLI probe+recommendations+contact/group chat in isolated data, project read check, hidden Electron acceptance and package acceptance.
- [ ] Fresh independent whole-branch review; reproduce and fix material findings; CI on latest commit.
- [ ] Update PR #51 to implementation, link GET-524, merge when gates pass. Package latest main with the machine-local signing certificate, preserve rollback and normal data, install by absolute path, verify running build/data and close issue only after acceptance.
