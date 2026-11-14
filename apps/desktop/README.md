# @agentstudio/desktop

## Open the current desktop workspace in a browser

This requires an updated package with `browserWorkspace: 1` in its build receipt; older native-only packages are refused. With the installed app running, use `pnpm open:personal:web`. Add `--print-url` to print its current localhost URL, or `--app /absolute/AgentRoom.app` to select an installation. This opens the same desktop-owned workspace and contacts, rather than the separate development Web profile. The command verifies the actual application process, its child runtime and the packaged source revision; it never starts or takes over a server.

Packaged assets use a separate flat-name route with realpath containment; the server does not expose the renderer parent directory. The page is local to that Mac, requires its app to remain running and retains the existing loopback Host/Origin checks. Original service sign-in remains in the native app. This is not a hosted Web service or the future cross-device directory: see [directory design and delivery stages](../../docs/superpowers/specs/2026-11-13-unified-agent-directory-design.md).

## AgentRoom name and repeatable first-use testing

The visible app and packaged bundle are now AgentRoom. Storage, safeStorage identity, IPC and package names remain compatible. Preferences → 测试与引导 can reopen onboarding, enter an isolated test profile, reset it to a fresh identity, or return to the original profile. `pnpm dev:desktop:test` opens test mode directly. See [scope, recovery and verification](../../docs/personal/testing.md).

The macOS Electron app opens the personal messenger by default: contacts, direct/group chats, and unified approvals. It preserves the existing `hiddenInset` window, traffic lights, draggable regions and Mac menus. Conversations own their progress, versioned decisions and Markdown results. Existing task threads continue directly in the same Messenger shell, preserving their original drafts, execution mode, connection and exact pending request identity. Old `?workspace=tasks` links remain compatible; they no longer select a different renderer. The original Matrix inbox is retained with `AGENTSTUDIO_WORKSPACE=matrix`.

## Build and run the Mac app

Automatic updates are currently a [design proposal (GET-495)](../../docs/superpowers/specs/2026-11-11-macos-auto-update-design.md), with a [standalone interaction preview](../../docs/personal/macos-update-preview.html). The design places a version-aware restart indicator above Refresh in the lower-left navigation rail. It does not enable updates in the current ad-hoc bundle; signed distribution and real upgrade acceptance remain separate implementation work.

From the repository root, with Node 22.13+ and pnpm installed:

```sh
pnpm install --filter '@agentstudio/desktop...' --frozen-lockfile
pnpm --filter @agentstudio/core build
pnpm --filter @agentstudio/desktop build
pnpm --filter @agentstudio/desktop start
```

The default personal mode needs no Go, Postgres, Synapse or Matrix bridge startup. Model work uses the selected local Codex, Claude Code or Pi adapter and its existing configuration; installed/configured does not prove a successful model call. Codex has a successful GET-479 real run; the Claude real run remains unsuccessful. Deterministic local organization and the explicitly synthetic sample work without a model. A missing executor or provider limit remains a blocker rather than generating a substitute result.

| Command | Scope |
| --- | --- |
| `pnpm dev:desktop` | Native Electron development entry; personal mode by default |
| `pnpm --filter @agentstudio/desktop build` / `start` | Build `out/`, then run the bundled local-file renderer |
| `pnpm package:mac` | Build a local Mac bundle using machine-local signing settings, or ad-hoc when unconfigured |
| `pnpm --filter @agentstudio/desktop typecheck` / `test` | TypeScript checks and desktop unit tests |
| `pnpm --filter @agentstudio/desktop e2e:smoke` | Retained Matrix smoke suite; explicitly selects Matrix mode and needs the old stack |

Electron is pinned to 45.2.1. Its postinstall download is allowed by the workspace configuration. If the binary is missing, run `node node_modules/electron/install.js` from this directory. A developer may use an existing proxy with `ELECTRON_GET_USE_PROXY=1` for that command; this does not change the binary version or checksum source.

## Runtime ownership and storage

In a built app, `out/renderer/personal/index.html` is a trusted local file, loaded with the dedicated `out/preload/personal.js`. Its only native bridge is `window.agentStudioPersonal`. It exposes fixed JSON API routes, change notifications, menu commands, native artifact saving, explicit runtime restart and the fixed `nativeIntegration` actions. There is no renderer API for arbitrary network requests, headers, files or shell commands, and the personal renderer cannot use the legacy session/connector IPC.

The main process starts one owned `utilityProcess` from `out/main/personal/worker.mjs`. The backend ESM modules listed in `electron.vite.config.ts` are copied there unchanged, including provider approvals and artifact collaboration. The utility uses Electron's bundled Node/SQLite, binds to a random loopback port and reports an ownership/workspace handshake. Main forwards only allowlisted `/api` requests to that exact child. Production `connect-src 'none'` keeps API HTTP out of the renderer; development additionally permits its own Vite origin for HMR. Backend CORS is not broadened for file pages.

Data defaults to `~/Library/Application Support/AgentStudio/personal`:

- `personal.sqlite` with WAL stores conversations, queues, decisions and results.
- `worker-lock.sqlite` holds the single-worker OS lock for that workspace.
- `vault/master.key` and `vault/credentials/` hold the personal Bearer file vault.
- `workspaces/` contains the per-run CLI working directories.

Native personal-service instances use the separate `app.getPath('userData')/personal-services` directory and `persist:agentstudio-personal-services-*` Chromium partitions. Connector credentials use an Electron `safeStorage` encrypted file; this is distinct from the backend Bearer file vault. No old Matrix credentials or unrelated browser profiles are imported.

The app never discovers or attaches to port 18740, imports `.local/personal`, or reads/migrates the old Matrix session on default startup. Explicit data-directory overrides are for deliberate workspace selection and isolated tests; an already-owned directory fails closed rather than attaching to another process.

Closing a Mac window hides it, so its utility can continue. Reopening the app reuses that window. Quit requests a graceful close of this owned utility; a bounded forced exit requires the same PID, creation time, Utility type and service name to match. Unknown remote effects remain unknown after recovery. One unexpected crash may restart the utility automatically; it does not replay a POST. Concurrent restart requests coalesce, a later shutdown supersedes an older restart, and a fresh explicit restart can begin a new lifecycle generation.

Messages sent during execution are saved as followup runs. Each run reads only through its own input message; later requirements do not silently change an already approved payload. New input invalidates an unapproved preview, and unresolved remote execution prevents the followup queue from crossing it. See [the backend contract](../personal/server/README.md).

## Local macOS packaging

```sh
pnpm package:mac
```

`package-mac.mjs` stages only built files and a minimal package descriptor, then invokes the pinned packager for the current Mac architecture. It targets `apps/desktop/dist` by default, prints the bundle path, verifies its local signature and writes `build-receipt.json`. `AGENTSTUDIO_MAC_OUTPUT` selects a separate output directory. `ELECTRON_ZIP_DIR` may point to a directory containing the pinned official Electron archive; the script checks its SHA-256 before reuse.

Signing defaults to the ad-hoc identity `-` on an unconfigured machine. For repeated local installations, pin one certificate in `~/.config/agentstudio/macos-signing.json` so every checkout uses the same system identity:

```json
{
  "identity": "REPLACE_WITH_THE_CERTIFICATE_40_CHARACTER_SHA1",
  "teamId": "TEAMID1234"
}
```

Find certificate fingerprints with `security find-identity -v -p codesigning`. Read the Team ID from the certificate's subject OU; the suffix of an Apple Development certificate's display name may instead be a member ID. Keep this file local. It contains public certificate identifiers, never the private key or a password. The packager does not select the first available identity or change Keychain permissions. `AGENTSTUDIO_MAC_SIGN_CONFIG` selects another config file. `AGENTSTUDIO_MAC_SIGN_IDENTITY` plus `AGENTSTUDIO_MAC_SIGN_TEAM` override the file; `AGENTSTUDIO_MAC_SIGN_IDENTITY=-` explicitly restores ad-hoc signing. A missing explicitly selected file, invalid pin, unavailable certificate or mismatched signed identity fails the build instead of falling back.

Both modes retain the local profile without Hardened Runtime and with only the JIT entitlement. Local signing explicitly disables the timestamp service, avoiding a network round trip for every nested signed file. The script verifies the deep signature, bundle identifier, flags and entitlements. Certificate mode additionally verifies the exact leaf certificate fingerprint, expected Team ID and a designated requirement that is not tied to a changing code hash; the receipt records these fields. It does not notarize, publish or claim Gatekeeper distribution acceptance. An Apple Development certificate is suitable for this local workflow; public distribution needs its own Developer ID/notarization profile, including secure timestamps.

This addresses repeated **Safe Storage** prompts after rebuilds: [Electron documents](https://www.electronjs.org/docs/latest/tutorial/code-signing#macos-apis-that-require-code-signing) that unsigned/ad-hoc identities can cause Keychain to ask again after each update. Preserve the existing `AgentStudio` safeStorage name, bundle ID and user-data directory. Moving from ad-hoc to certificate signing can still require one Keychain authorization; select **Always Allow** for this app's own Safe Storage item after checking the request. Unlocking a locked login keychain or authorizing codesign's signing private key is a separate prompt. Do not use the mock keychain with real login data or delete an existing Safe Storage item to suppress the dialog.

`pnpm test:dev` includes an actual ad-hoc codesign inspection on macOS (skipped on other platforms). With a local certificate configured, `AGENTSTUDIO_MAC_SIGN_NATIVE=1 node --test dev/macos-signing-native.test.mjs` also signs two different disposable bundles and verifies their certificate extraction and stable designated requirement. These fixtures do not read an account's Safe Storage item.

The local `.app` has previously been launched and checked for package-owned runtime, saved CLI/MCP history and export hashes; the packaged native smoke also passed. Exact versions, retry history and limits are in the [macOS acceptance ledger](../../docs/personal/macos-acceptance.md). A successful build alone is not that acceptance. During UI development, `pnpm dev:desktop` avoids repeatedly replacing the packaged binary.

Vite embeds the Git HEAD with `-dirty` when there are uncommitted files; an unavailable Git identity is `unknown-source`. The native health response includes that build reference, nine backend module hashes and the bundled personal UI-entry hash. `PERSONAL_BUILD_REF` is an explicit test override. A clean merged-source rebuild is required before labeling a bundle with the merge revision.

## Connect existing assistants

The connection page groups this Mac, personal Agents and common tools. Discovery checks fixed Codex/Claude/Pi/Gemini/OpenCode IDs; Codex, Claude and Pi have execution adapters; Gemini and OpenCode remain discovery/install hints. Version and noninteractive auth probes are bounded, do not read credential files or shell startup files, and return whitelisted status rather than raw output. `configured` means local login configuration, not account ownership, quota or network verification. A deliberate login button runs only the fixed vendor login command. Selecting an assistant is saved for future runs; each accepted run retains its own `localAgentId` snapshot.

Grok Bot, Muse, ChatGPT Dots and Cue reuse the native connectors through a main-owned loopback A2A adapter. Waiting/choice/input/cancel flows expose safe progress only; main registers the connection before reporting ready. Existing conversations are used without importing history. Saved provider credentials and A2A tokens are not returned to the renderer. A user-entered key passes through a transient password field and fixed IPC; only flow metadata is saved for UI recovery. Provider-side decisions stay in the original service and are never automatically approved. `canOpen: false` gives an explicit instruction to use the original app.

DeepWiki/Exa presets perform real MCP initialization and discovery on click. A custom URL attempts a same-origin Agent Card, then MCP; the complete name/protocol/address form remains under Advanced. Connection does not approve later actions: the existing exact endpoint/payload/tool approval still applies. No generic OAuth, stdio MCP, account-ownership proof or public deployment is added.

Cancellation waits for the owned CLI to exit. An unconfirmed stop (`stop_unconfirmed` / `stopUnconfirmed`, the stop_unknown acceptance scenario) retains unknown state and blocks new work using that assistant; repeated cancel or restart does not clear it. Native service tasks persist before send and use stable message IDs. Interrupted or uncorrelated replies are not retried or accepted as results; retain the original task ID and connection for readback. An instance with unresolved work cannot be removed. See the [connection design](../../docs/personal/connection-design.md) and [GET-479 acceptance ledger](../../docs/personal/connection-acceptance.md) for current evidence and gaps. Synthetic tests for the four services do not establish real private-account acceptance.

## Configuration

| Variable | Scope |
| --- | --- |
| `AGENTSTUDIO_WORKSPACE=matrix` | Select the retained Matrix renderer and connectors; otherwise personal mode |
| `AGENTSTUDIO_USER_DATA_DIR` | Override Electron's whole profile; tests should use an isolated directory |
| `AGENTSTUDIO_PERSONAL_DATA_DIR` | Explicit personal backend workspace override; no automatic migration |
| `AGENTSTUDIO_CODEX_BIN` | Explicit local Codex executable; provider/login configuration stays with that CLI |
| `AGENTSTUDIO_PERSONAL_EXPORT_DIR` | Task-scoped test destination instead of a native save dialog |
| `PERSONAL_BUILD_REF` | Explicit runtime provenance override for controlled tests |
| `AGENTSTUDIO_SERVER_URL` | Matrix mode only: server URL before the saved setting, default `http://127.0.0.1:18090` |
| `AGENTSTUDIO_MOCK_KEYCHAIN=1` | Isolated legacy tests use Chromium's mock keychain |
| `AGENTSTUDIO_MAC_SIGN_CONFIG` | Packaging only: explicit machine-local signing JSON path; otherwise `~/.config/agentstudio/macos-signing.json` |
| `AGENTSTUDIO_MAC_SIGN_IDENTITY` / `AGENTSTUDIO_MAC_SIGN_TEAM` | Packaging only: pinned certificate SHA-1 and expected Team ID; identity `-` explicitly selects ad-hoc |
| `AGENTSTUDIO_TEST_NOTIFICATIONS=1` | Legacy tests record notifications instead of showing them |

The `PERSONAL_PORT`/`PERSONAL_DATA_DIR` settings belong to the standalone web server, not the native host's automatic port/profile selection.

## Credentials and actual controls

Personal Bearer credentials use an AES-256-GCM **file vault, not Keychain**. The key and encrypted records are 0600, directories 0700, and both must be protected in backups. This does not isolate other processes running as the same OS user. Different tokens at the same endpoint remain separate connection identities; a private identity/version binding prevents an old approval from changing accounts. The displayed label is user-entered, and `identityVerified` remains false. Generic OAuth, arbitrary authentication headers and general remote account proof are not implemented; native service-specific login is separate.

The CLI keeps its configured provider. Codex requests read-only shell mode; Claude's separate adapter requests safe mode, no tools, empty MCP and plan permissions. A separate working directory and task prompts do not enforce a mandatory sandbox over every preconfigured Codex tool or plugin. A saved artifact hash proves byte consistency; a successful remote response does not independently prove an external side effect. Only approved material goes to the selected remote service. Native services create their own isolated sign-in sessions; unrelated browser sessions and legacy tokens are not imported.

## Retained Matrix mode

```sh
pnpm dev:up
AGENTSTUDIO_WORKSPACE=matrix pnpm dev:desktop
```

This path retains `out/renderer/index.html`, `out/preload/index.js`, `window.agentStudioDesktop`, its safeStorage session and original connectors. Its renderer's network CSP stays scoped to the configured server origin. The stack commands still manage the legacy `.local/` services; they do not reset the native personal profile. Full cross-client legacy E2E uses `AGENTSTUDIO_WORKSPACE=matrix pnpm test:e2e`.

Setup, current evidence and explicit gaps: [personal guide](../../docs/personal/README.md), [macOS acceptance](../../docs/personal/macos-acceptance.md), [Mac decision record](../../docs/personal/macos-decision.md), [historical web acceptance](../../docs/personal/acceptance.md).

## Shared artifacts from group conversations

The personal desktop now supports a host-owned artifact library, native Codex/Pi tools, version-bound creation/permission cards and immutable static-document/website revisions. Work uses the existing single execution lane. Main serves checked revision files through an opaque `agentroom-artifact:` capability in a sandboxed iframe and owns a serialized hidden-window preview check; the utility receives its verdict over the private parent channel. No renderer verdict route, arbitrary command, network capability or model-generated approval HTML is exposed. Owner edit/import/accept/restore/archive and native reveal/export actions remain fixed capabilities.

Workflow, current limits and directory layout: [coauthoring guide](../../docs/personal/artifact-coauthoring.md). Actual native, model and CI evidence: [acceptance record](../../docs/personal/artifact-coauthoring-acceptance-2026-11-11.md). Native deterministic acceptance is `node dev/artifact-coauthoring-acceptance.mjs` after building; `--expect-preview-block` checks actual page-error gating, `--real` uses actual configured models in an isolated profile.

Group sharing now uses ordinary Messenger threads and the normal worker ledger. The group header owns member/status, artifacts, invitation review and Agent-rule controls. Models use scoped group tools; external guests accept a nickname invitation and use the same timeline through the separate guest listener. Shared notes and fixed poll/consensus games are real Library artifacts. See [sharing workflow](../../docs/personal/guest-playrooms.md); old standalone invitation data migrates without replaying model executions.
