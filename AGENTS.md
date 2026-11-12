# AgentRoom: working agreement for humans and coding agents

## Canonical repository

All new development, issues, PRs, CI and releases use **https://github.com/getyak/agentroom** and its `main` branch. Fetch it before substantial work. New local checkouts use this repository as `origin`; the regular checkout on the shared host is `~/data/agentroom`. Preserve active legacy AgentStudio worktrees rather than rewriting their shared remotes. See `docs/repository.md`.

This repository change does not rename `@agentstudio/*`, the Go module, bundle/IPC identities or existing data directories. Such migrations need their own design and acceptance.

AgentRoom is an open-source inbox for your chats and your AI agents (Apache-2.0). Read these first; they are the contracts:

- `docs/README.md`: documentation map and evidence conventions
- `docs/architecture.md`: current processes, module ownership, data and trust paths
- `docs/detailed-design.md`: identity, execution, decisions, recovery and artifact rules
- `docs/design.md`: current interaction and visual design
- `docs/plans/architecture-evolution.md`: proposed future implementation sequence
- `docs/legacy-matrix.md`: retained Matrix setup and ports
- `docs/api.md`: personal desktop IPC and REST APIs
- `docs/agent-protocol.md`: how agents connect
- `docs/matrix-events.md`: Matrix conventions, custom events, demo network
- `docs/clients.md`: screens and the `data-testid` contract used by e2e
- `docs/connectors.md`: the Mac app's connectors for Grok Bot, Muse, ChatGPT Dots and Cue (personal use only: see README)
- `docs/roadmap.md`: what's done and what's next
- `CONTRIBUTING.md`, `SECURITY.md`: how to contribute, and how to report a vulnerability

When code and these docs disagree, fix whichever one is wrong in the same change. Never leave them out of sync.

## Commands

| Command | What |
|---|---|
| `pnpm install` | install JS workspace deps |
| `pnpm dev:up` | build Go binaries and start the whole local stack (idempotent) |
| `pnpm dev:down` | stop everything |
| `pnpm dev:status` | show process health |
| `pnpm dev:reset` | stop and wipe `.local/` |
| `pnpm dev:desktop` | run the Electron personal workspace by default; no Matrix stack required |
| `AGENTSTUDIO_WORKSPACE=matrix pnpm dev:desktop` | run the retained Matrix inbox against the local stack |
| `pnpm package:mac` | build a local Mac bundle (machine-local certificate pin, otherwise ad-hoc); launch acceptance and notarized distribution are separate |
| `pnpm dev:mobile` | run Expo (web) against the local stack on http://localhost:18300 |
| `pnpm test` | unit tests: stack manager (`node --test dev/stack.test.mjs`), Go (`cd server && go test -tags nocrypto ./...`) and TS (vitest) |
| `AGENTSTUDIO_WORKSPACE=matrix pnpm test:e2e` | retained Matrix e2e (Playwright projects `desktop` and `mobile-web`) against the local stack; starts it if needed and builds both apps. See `e2e/README.md` |

The default personal desktop utility owns `app.getPath('userData')/personal` (normally `~/Library/Application Support/AgentStudio/personal`), with an explicit `AGENTSTUDIO_PERSONAL_DATA_DIR` override. The renderer uses the separate `agentStudioPersonal` preload and fixed IPC, not API HTTP. It does not import legacy sessions or attach to a standalone web server. See `apps/desktop/README.md`.

Legacy stack state, logs and generated secrets live in `.local/`, which is git-ignored:

- logs: `.local/logs/<process>.log`
- generated env: `.local/env`

## Conventions

- **Go:**
  - module `github.com/DolphinMiner/agentstudio/server`
  - Go 1.26, `log/slog` for logs, `pgx/v5` for Postgres
  - bridges are built on `maunium.net/go/mautrix` bridgev2
  - always build/test with `-tags nocrypto` (no E2EE in v0.1, so mautrix is built without libolm; plain `go build ./...` fails on `olm/olm.h`)
  - never log message bodies or tokens
- **TypeScript:**
  - strict mode, ESM, pnpm workspaces
  - `@agentstudio/core` must not import DOM, Node or React Native APIs
  - React 19 function components
- **Tests:** select elements only by `data-testid` / `testID` from `docs/clients.md`. Use no sleeps when a condition can be awaited.
- **Native acceptance:** prefer browser checks first. Use `launchDesktopTest` from `dev/desktop-test-env.mjs` for native automation; build first and retain its version check and host-wide lock. Default to hidden windows. `AGENTROOM_AUTOMATION_VISIBLE=1` is only for explicitly coordinated OS-window/focus acceptance, not routine screenshots. Launch packages by absolute executable path; preserve recovery copies as `.bundle`/archives rather than discoverable `.app` files. See `docs/personal/testing.md`.
- **No Docker.** The local stack runs native processes: Homebrew Postgres 18 in a private cluster under `.local/pg`, and Synapse in a uv venv.
- **Keep diffs focused.** Do not reformat files you did not change.
- **Connectors for third-party services** reach the user's own agents with the user's own account, on the user's Mac. Don't add anything that works at scale, for other people's accounts, or around a service's limits. Never commit real transcripts, tokens or cookies; scrub fixtures to their structure.
