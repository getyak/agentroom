<p align="center"><img src="apps/desktop/resources/icon.png" alt="" width="128"></p>

**AgentRoom** is the new product name. Preferences → 测试与引导 offers an isolated test workspace, fresh onboarding, and a return to your original workspace. Run `pnpm dev:desktop:test` from source. See [testing and compatibility](docs/personal/testing.md).

<h1 align="center">AgentRoom</h1>

[Download the macOS alpha](https://github.com/getyak/agentroom/releases) · [Release notes](docs/releases/0.2.0-alpha.1.md)

Start with **阿屋 Roo**, your room's first companion. Roo uses the AgentRoom mascot and an eligible local assistant to help you discover this computer, connect existing accounts and add contacts. Existing workspaces keep their data; Settings → 测试与引导 reopens the guide. This independent repository continues the AgentStudio source history and notices.

**The Mac app opens a personal messenger by default.** Create agent contacts, chat directly,
bring your own agents into a group, and review their actions in one approval inbox. Its owned
Electron utility runs SQLite locally; no Matrix stack is needed for this mode. See
[Mac setup and boundaries](docs/personal/README.md). The standalone web interface remains a
development and QA companion.

**English** · [简体中文](README.zh-CN.md)

<p align="center">
  <img src="docs/media/agentroom-welcome.png" alt="AgentRoom: your people and your agents, in one inbox. The Mac app with a dinner booking from Muse waiting for approval." width="900">
</p>

> [!WARNING]
> **FOR PERSONAL USE ONLY.** AgentRoom is a personal tool for learning and research: run it on your own Mac, with your own accounts, to reach your own agents. **NOT FOR COMMERCIAL USE**, and not for running a service for other people. Use it at your own risk. Read the [Disclaimer](#disclaimer) first.

> **Alpha.** The Apple Silicon download is ad-hoc signed and not Apple notarized. See the release notes for installation, checksums and source provenance. Source builds remain available. Expect rough edges and breaking changes.

The default workspace keeps contact identities, private/group conversations, background execution, exact approval previews and saved results together. Human contacts are currently local-only; cross-device human messaging is a future step. Existing task conversations keep a visible resume action with their original drafts. The original chats-and-agents inbox is retained with `AGENTSTUDIO_WORKSPACE=matrix`; it uses its existing accounts and services without an automatic migration.

Status: early development (v0.1). macOS first: the desktop app (Electron) comes first, then mobile (Expo). Nothing here is hosted yet; everything runs on your Mac.

<p align="center">
  <a href="docs/media/agentstudio-demo.mp4">
    <img src="docs/media/agentstudio-demo.gif" alt="A 75-second tour: chat with a Grok bot and approve its report, ask Muse about the weather and approve a dinner booking, have ChatGPT Dots draft a reply to Leo, and connect Grok Bot, Cue, Muse and ChatGPT" width="820">
  </a>
  <br>
  <sub>A 75-second tour. <a href="docs/media/agentstudio-demo.mp4">Watch it in 4K (MP4)</a>.</sub>
</p>

The Matrix gallery and video document the retained inbox. The default personal workspace has its own [guide and acceptance ledger](docs/personal/README.md).

## What it does

- **Personal messenger:** discover local agents, create distinct identities, reuse direct conversations, and form groups with per-agent mention/always/paused response policies. See the [messenger guide](docs/personal/messenger.md).
- **Click to connect:** discover existing local assistants, choose Codex or Claude Code, sign in to personal services, or enable DeepWiki and Exa without entering protocol settings. See [connection setup and evidence](docs/personal/connection-design.md).
- **Local execution:** use the selected CLI or explicitly choose deterministic local organization. Missing CLI or provider limits remain visible blockers; Claude's real execution remains unverified in this batch.
- **Approved connections:** prepare an A2A submission or exact MCP call, then approve its target and payload. A successful tool response is distinct from independent verification of an external effect.
- **Native persistence:** closing the Mac window hides it while its utility continues. Quit shuts down that owned utility; saved queues and uncertain results are recovered on the next launch.

### Retained Matrix inbox

- **One inbox** for chats and agents. People are circles, agents are squircles, and each one carries a small mark for the network or service it lives on.
- **Approvals.** An agent asks, you decide in one tap, from the chat or from the Approvals screen.
- **Ask an agent.** Forward a chat with its context to an agent; its reply drafts come back, ready to edit and send.
- **Agents you already use**, through your own sign-in on the Mac: Grok Bot (every bot of your account, with its own name and avatar), Muse, ChatGPT Dots and Cue (sign in with Manus, or use a Manus API key). Experimental and for personal use only: see [below](#disclaimer).
- **Agents that speak an open protocol**: the [AgentRoom Agent Protocol](docs/agent-protocol.md), A2A, and ACP. Hermes Agent and OpenClaw are recognized and shown with their own icons.

<p align="center">
  <img src="docs/media/approvals.jpg" alt="Agents ask before they act: a Grok bot asks whether to send the weekly report, with Send it and Don't send buttons" width="820">
</p>
<p align="center">
  <img src="docs/media/ask.jpg" alt="Ask an agent about any message: pick an agent and the lines it may read, and get reply drafts back" width="820">
</p>
<p align="center">
  <img src="docs/media/connect.jpg" alt="Bring the agents you already use: the Connect screen with Grok Bot, Muse, ChatGPT Dots and Cue, and Grok Bot's two connected bots" width="820">
</p>

## How it is built

| Part | Where | What |
|---|---|---|
| Desktop app | `apps/desktop` | Default native personal renderer, separate preload and owned utility. Matrix mode retains its original renderer and connectors. |
| Personal workspace | `apps/personal` | Shared conversation/reading UI and Node/SQLite task engine; also provides the auxiliary web entry. |
| Mobile app | `apps/mobile` | Expo / React Native. Tested on the web target until native builds land. |
| Client core | `packages/core` | Matrix client, inbox, approvals, tasks; shared by Matrix desktop and mobile. |
| Brand assets | `packages/brand` | Official images of the services AgentRoom connects to, with sources. |
| Server | `server` (Go) | `agentstudio-api`, the `agentstudio-agents` and `demo` bridges (mautrix bridgev2), protocol adapters, the reference agent. |
| Homeserver | Synapse | Underlies the retained Matrix route, federation off. |
| Dev stack | `dev/stack.mjs` | Starts everything locally as native processes, no Docker. |
| End-to-end tests | `e2e` | Playwright against the Electron app and the mobile web build. |

More in [docs/architecture.md](docs/architecture.md). Other docs: [API](docs/api.md), [clients](docs/clients.md), [design](docs/design.md), [Matrix events](docs/matrix-events.md).

## Quick start (macOS)

For the default Mac app: Node 22.13+ and pnpm. Model tasks also need an installed and configured Codex CLI; the built-in local sample does not call a model.

```bash
pnpm install --filter '@agentstudio/desktop...' --frozen-lockfile
pnpm --filter @agentstudio/core build
pnpm --filter @agentstudio/desktop build
pnpm --filter @agentstudio/desktop start
```

The built renderer loads from local files. The app starts its own utility on a random loopback port and stores personal data in `~/Library/Application Support/AgentStudio/personal`. It does not attach to an existing web server or import the old Matrix session. `pnpm dev:desktop` is the native development entry.

`pnpm package:mac` targets a local `.app` under `apps/desktop/dist`, using a configured certificate pin or ad-hoc signing when unconfigured; the command prints the bundle path and writes a build receipt. A consistent certificate can reduce repeated Safe Storage prompts after local updates. The local bundle has passed native launch, saved-result readback and UI checks; see [macOS acceptance](docs/personal/macos-acceptance.md). It is not a notarized release or private-account acceptance. See [desktop packaging](apps/desktop/README.md#local-macos-packaging).

### Retained Matrix route

This route additionally needs Go 1.26+, Homebrew PostgreSQL 18 and uv:

```bash
pnpm install
pnpm dev:up        # Postgres, Synapse, API, bridges, reference agents (first run: about 30 s)
AGENTSTUDIO_WORKSPACE=matrix pnpm dev:desktop
pnpm dev:mobile    # mobile app on the Expo web target: http://localhost:18300
```

There's no account to create: the stack runs in local mode, so the app opens straight to your inbox.
(To try email sign-in instead, pick "Sign in with email instead" after signing out. In dev mode the code isn't mailed; it is shown at
`http://127.0.0.1:18090/v1/dev/outbox?email=<your email>` and in `.local/logs/api.log`.)
Then, on the Connect screen, add the **Demo** network (simulated contacts) and the **Concierge** agent, or sign in to one of the agents you already use.

Managing the stack:

```bash
pnpm dev:status          # what's running
pnpm dev:restart <name>  # restart one service, e.g. api, agents
pnpm dev:logs <name>     # follow a service's log
pnpm dev:down            # stop everything
pnpm dev:reset           # stop and delete all local data in .local/
```

The legacy stack keeps its databases, Synapse and logs in the ignored `.local/` directory. The auxiliary personal web server uses `.local/personal`; the default Mac app uses its own profile directory instead.

## Tests

```bash
pnpm test        # unit tests: stack manager, Go, TypeScript
AGENTSTUDIO_WORKSPACE=matrix pnpm test:e2e    # retained Matrix Electron + mobile web against the local stack
```

If the Electron binary is missing after `pnpm install` (pnpm can skip its postinstall), run
`node node_modules/electron/install.js` in `apps/desktop`. Install Playwright's Chromium with
`pnpm --filter @agentstudio/e2e exec playwright install chromium`.

## Connecting agents

In the default personal workspace, add your own A2A or MCP endpoint in preferences, optionally with a Bearer token. Each external submission still needs its exact approval. Personal Bearer credentials use an AES-256-GCM file vault, **not Keychain**; the local OS account and protected backups remain the boundary. OAuth, arbitrary authentication headers and general account-identity proof are not implemented. CLI instructions and a separate working directory are not a mandatory sandbox for every configured tool. Full limits are in [the personal guide](docs/personal/README.md#实际控制边界).

The following connector table belongs to `AGENTSTUDIO_WORKSPACE=matrix`:

| Agent | How |
|---|---|
| Concierge (built-in reference agent) | Connect → Agents on your server → Concierge |
| Any AgentRoom Agent Protocol endpoint | Connect → AgentRoom agent endpoint, then its URL and token |
| A2A agents (for example Hermes Agent) | Connect → A2A agent, then the agent's URL |
| ACP agents allowed by the server (`AGENTSTUDIO_ACP_AGENTS`) | Connect → ACP agent |
| Grok Bot, Muse, ChatGPT Dots, Cue (Mac app only, experimental) | Connect → Agents you already use. Your sign-in (or Cue's API key) stays on the Mac, and these agents answer while AgentRoom is open. |

Read [the note on third-party connectors](#disclaimer) before connecting Grok Bot, Muse, Dots or Cue.

To debug a connector, start the app with `AGENTSTUDIO_CONNECTOR_TRACE=1` (and `AGENTSTUDIO_CONNECTOR_SHOW=1` to see the hidden Muse / Dots windows). See [docs/connectors.md](docs/connectors.md).

## Disclaimer

**⚖️ FOR PERSONAL LEARNING AND RESEARCH USE ONLY.** Read this before you use AgentRoom, and in particular its connectors for Grok Bot, Muse, ChatGPT Dots and Cue.

- **Personal use only.** Use AgentRoom on your own Mac, with your own accounts, to reach your own agents. Don't use it commercially, to run a service for others, to automate at scale, or with accounts that aren't yours.
- **Local app and storage.** There is no hosted AgentRoom server. Selected context is sent to your configured model provider or an approved remote agent/tool. Legacy sign-ins use Electron safeStorage; personal Bearer credentials use the documented local file vault, not Keychain.
- **Not affiliated.** AgentRoom isn't affiliated with or endorsed by xAI / SpaceX AI, Cursor (Anysphere), Meta, OpenAI, Manus, Nous Research or OpenClaw. Their names and logos are trademarks of their owners and appear only to say which service a connector reaches.
- **Unofficial connectors.** Except for Cue's messaging (Manus's documented API), the connectors work the way each service's own app or website does. That may be against a service's terms, and it can stop working at any time.
- **Your responsibility.** You are responsible for following each service's terms and the laws where you live. If you aren't sure, don't connect it.
- **Use at your own risk.** AgentRoom comes "as is", without warranty of any kind (see the Apache-2.0 license). The authors aren't liable for any loss, account restriction or other consequence of using it.

Details per service: [docs/connectors.md](docs/connectors.md).

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md): how to set up, test and send a change.
- [SECURITY.md](SECURITY.md): how to report a vulnerability privately. Please don't open a public issue for one.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Apache-2.0. Third-party notices are in [NOTICES.md](NOTICES.md); brand images belong to their owners (see [packages/brand/README.md](packages/brand/README.md)).
