# Personal workspace server

This engine runs the personal workspace without Matrix, Postgres, Docker, or additional server dependencies. The default entry is the existing [macOS Electron app](../../desktop/README.md): its owned utility runs the copied backend ESM modules, including `decisions` and `decision-views`, with Electron's bundled Node/SQLite, `serveStatic:false`, a random loopback port and data in `app.getPath('userData')/personal`. The trusted file renderer calls a separate narrow preload/IPC bridge; it does not make API HTTP requests. Native startup does not attach to port 18740 or import old Matrix/web data. The separate main-owned native-service adapter restores only its own existing personal manifest; without one it initializes lazily on catalog/connection actions, as described in [the connector contract](../../../docs/connectors.md#personal-workspace-native-services).

The same Node 22.13+ service can run independently for auxiliary web development and QA. It binds to loopback and serves `apps/personal/dist` plus `/api`. Run from the repository root:

```sh
pnpm --filter @agentstudio/personal build
node apps/personal/server/index.mjs
node --test apps/personal/server/*.test.mjs
```

Standalone web default URL: `http://127.0.0.1:18740`. `PERSONAL_PORT` and `PERSONAL_DATA_DIR` override that service's port and `.local/personal` data directory. Development uses the personal package's `dev` command and a Vite proxy on port 18741. Native selection instead uses `AGENTSTUDIO_PERSONAL_DATA_DIR` or the Electron profile; web environment settings do not change its automatic port.

`createPersonalServer({dataDir, port, host, serveStatic})` is exported from `index.mjs`; it returns `{server, store, worker, listen(), address(), close()}`. Test-only process arguments and observers can be supplied through `codexCommand`, `codexArgs`, and `onChange`. Closing the native window hides it; quitting closes the owned utility. Startup restores queued work and retains unknown execution for reconciliation. Desktop crash recovery never blindly repeats a POST. Native lifecycle details and the fixed IPC allowlist are in the [desktop guide](../../desktop/README.md) and [API contract](../../../docs/api.md).

## Execution and routing

- `mode: "codex"` is the compatibility name for default automatic routing, using the run's selected Codex, Claude Code or Pi adapter. `body.localAgentId` accepts `codex|claude|pi`; when omitted, input acceptance snapshots the saved default (`codex` initially). Without connections it saves actual final assistant output; with connections a local planning turn chooses a document, A2A submission, MCP action, or specific question. A document plan includes the Markdown. An invalid plan blocks dispatch. Runs retain `localAgentId`, plus `requestedMode`, `chosenExecutor`, and `routingReason` when automatically routed; changing defaults never rewrites accepted runs.
- `mode: "local"` explicitly runs deterministic statistics and organization without a model. The report includes counts, duplicate-line statistics, and complete uploaded Markdown originals. It makes no semantic judgments.
- `mode: "connection"` selects a specific `connectionId`. A2A prepares a submission preview. MCP can accept an exact `action` or ask the selected local adapter to prepare one from the discovered catalog and this thread. Missing parameters produce a specific question in a `blocked` thread; a new message can supply the answer.
- Legacy A2A task submissions and MCP operations require exact authorization through the utility's Decisions module. MCP defaults to one versioned approval; the owner may explicitly authorize identical operations in the same conversation for at most one hour and ten operations, including the first. Addressed A2A contact chat sends directly through its accepted private endpoint/credential binding, without fabricating a decision. `readOnlyHint`, descriptions and model routing cannot grant tool/task permission. Optional readback calls and expected values are included in that same preview. Reuse additionally binds the full tool/readback declarations, connection/account/session, accepted contact and audience; the grant is revocable.
- Only the current thread, its uploaded text, and explicitly selected `memoryIds` enter the model prompt. Attachment context includes `id` and `citeAs: "#source-<id>"` for links to current-thread source previews. Source text and catalogs are marked untrusted. Those labels and prompts are instructions, not a tool sandbox.

Messages sent while a run is queued, running, or verifying are saved as durable followup runs in the same thread. The response says the supplement was saved, not that the current run read it. The app-owned bounded worker preserves order per conversation/agent while up to three independent invocations execute concurrently. Each run's input ends at its own `messageId`; an earlier queued run cannot inspect later messages or uploads, including when it starts after those messages were saved. The cutoff also applies to local organization and remote previews. A new message while an unapproved preview is pending cancels that old card with an explicit reason; the replacement run must prepare and obtain its own approval. Unknown execution remains a reconciliation barrier, so saved followups cannot advance past it and new submissions are rejected until it is resolved.

Codex runs `exec --json --ephemeral --skip-git-repo-check -s read-only -C <per-run workspace> -`, receiving context through stdin. A successful result requires an assistant item, a completed turn, and exit code 0. No bypass flag, provider switch, or global permission expansion is added. The user's configured provider and CLI tools remain in effect. An empty working directory is **not** filesystem isolation, and read-only shell policy does not independently restrict every configured remote tool. Missing CLI, authentication/configuration errors, and provider quota failures block execution. The server does not interpret a model's claim of execution as an external receipt.

Claude uses a separate capability-checked noninteractive JSON adapter with safe mode, no builtin tools, disabled slash commands/hooks and no session persistence. Ordinary chat uses strict empty MCP configuration and plan permissions. Scoped chat tools instead use only the session-owned AgentRoom stdio MCP proxy, exact allowed tool names and default permission mode; the proxy can discover or submit an approval, never bypass Decisions. No global CLI settings are changed. It retains its own authentication/provider configuration and parses only successful final result events, never stderr as a report. Discovery checks fixed Codex/Claude/Pi/Gemini/OpenCode IDs with bounded version/auth probes; Codex/Claude/Pi have execution adapters. `configured` describes local login configuration, not account ownership, quota or actual inference success. The first GET-479 Claude real run failed; subsequent real Codex/public MCP and synthetic results are recorded separately in [the connection ledger](../../../docs/personal/connection-acceptance.md).

Cancellation first requests an owned process stop and waits for exit. `stop_unconfirmed` / `stopUnconfirmed` (the stop_unknown scenario) retains unknown state and blocks another invocation using that assistant across threads. Repeated cancel or restart does not clear this barrier. Only the owned child/process group can be terminated; existing provider permissions are not expanded to work around a failure.

## REST and events

All JSON uses camelCase. Errors are `{error:{code,message}}`. Mutating task, message, decision, retry, cancel, and memory requests require a unique 8–160 character `clientId`. Repeating the same route/key returns its original response; different content with the same key returns 409. Clients should reload the authoritative snapshot after a retry or reconnect.

| Route | Request / response |
| --- | --- |
| `GET /api/health` | Health and `build:{ref,serverFiles,uiEntrySha256}`; SHA-256 entries for all eleven backend `.mjs` files, desktop adds bundled runtime versions/UI provenance |
| `GET /api/bootstrap` | `{threads,connections,memories,settings,runtime}`; `settings.localAgentId` is the saved default, while `codexAvailable` remains the legacy install check |
| `GET /api/integrations` | `{checkedAt,agents,selectedLocalAgentId,presets}`; fixed local discovery and safe preset metadata |
| `POST /api/integrations/refresh` | `{}` → refreshed discovery, no model/login invocation |
| `POST /api/integrations/local/:id` | `{}`, only `codex|claude|pi` → `{selectedLocalAgentId}`; installed, supported, auth configured required; otherwise 409 |
| `POST /api/integrations/connect` | `{presetId,clientId?}` or `{url,token?,clientId?}` → public connection (201), real discovery/handshake before success |
| `GET /api/threads/:id` | Full thread with messages, runs, artifacts, decisions, and events |
| `POST /api/threads` | `{text,clientId,mode?,localAgentId?:"codex"\|"claude"\|"pi",connectionId?,attachments?:[{name,text}],memoryIds?:[],action?}` → full thread |
| `POST /api/threads/:id/messages` | Same input, new run in the existing thread |
| `POST /api/threads/:id/retry` | `{clientId,runId?}`; safe retry, or original A2A task readback when its taskId is known |
| `POST /api/threads/:id/reconcile` | `{clientId,runId?}`; `tasks/get` on an existing A2A taskId, never `message/send` |
| `POST /api/threads/:id/cancel` | `{clientId,runId?}`; defaults to the currently running/verifying run, then pending/queued work; cancels that recorded run's local execution/waiting, without claiming remote cancellation |
| `POST /api/decisions/:id` | `{choice:"approve"\|"reject",version,clientId}` → full thread |
| `GET /api/artifacts/:id` | Metadata plus Markdown `body`, verified against its SHA-256 before returning |
| `GET /api/artifacts/:id/download` | Markdown attachment |
| `GET/POST /api/memories` | List / create `{text,clientId}`; explicit user-saved memory only |
| `DELETE /api/memories/:id` | Remove memory |
| `GET/POST /api/connections` | List / add `{name,type:"a2a"\|"mcp",url,token?,clientId?}`; optional Bearer token is never returned |
| `DELETE /api/connections/:id` | Remove an unused connection; unresolved external tasks retain their connection |
| `GET /api/connections/:id/tools` | MCP initialization/discovery; returns `{tools,protocolVersion,supported,notice}` |
| `GET /api/events` | SSE `invalidation` events containing optional `threadId`; reconnect and reload snapshots |

Requests are limited to 2 MB; text to 30,000 characters; each of up to 20 attachments to 500,000 characters; explicit memory selection to 20 IDs. Uploads are text only. The server does not fetch arbitrary attachment URLs or extract binary files.

### Discovery and quick-connect details

Discovery entries are `{id,name,installed,version,auth:{status,method?},execution:{supported,reason?},setupUrl,loginCommandId}`. Auth status is `configured|required|unknown|unsupported`. Only whitelisted parsed version/auth information leaves the probe; no executable path, raw stdout/stderr, credential file or private history is returned. Codex uses fixed `login status`; Claude uses `auth status` with its default JSON output. Defaults are concurrency 2, per-probe timeout 2.5 seconds and 15-second cache; refresh forces a new scan while concurrent scans share pending work. HTTP/renderer input cannot inject server-only command paths, arguments or dependency overrides. Native explicit login is a separate fixed main-process action, not an HTTP login route.

Production presets are fixed: `deepwiki` → `https://mcp.deepwiki.com/mcp`, `exa` → `https://mcp.exa.ai/mcp`. Public metadata is `{id,name,description,account,connectionId|null}`. Preset connect takes its fixed name/type/URL, initializes MCP and lists tools; it never calls a tool. Unknown preset or nonempty URL/token override returns 400. Clients should send only `presetId` and optional `clientId`; custom headers and extra quick-connect fields are rejected.

Custom URL discovery skips Agent Card lookup for `/mcp` or `/sse`; an explicit `.json` URL is tried as a card, otherwise the two same-origin well-known Agent Card paths are tried with bounded responses and redirects disabled. A valid card supplies a cleaned name and same-origin JSON-RPC endpoint; a cross-origin advertised endpoint is rejected before credential transfer. No card falls back to MCP initialization/tool discovery and a host-derived name. Card metadata, `checkedAt`, or public connection status `checked` does not prove account identity, health forever or an executed task. Remote URLs require HTTPS, loopback may use HTTP; userinfo/query/fragment are rejected. No port scanning or stdio MCP process support is added.

Connection `clientId` is optional, unlike required task/decision/memory keys; when supplied it must be 8–160 characters. Quick-connect persists a receipt in the `integrations:create` namespace using the original request and a private keyed credential fingerprint, not the secret. The same accepted request replays before new discovery, even if remote metadata changes or the provider becomes unavailable. Concurrent identical requests share one pending discovery; changed URL/preset/token with the same key returns 409. Endpoint/type/credential deduplication is separate: a new request key does not authorize replacing another account. Failed discovery is not a successful receipt. Refresh and selecting a default take `{}` and require no idempotency key.

`build.serverFiles` names every current source module, including the IM participation module, alongside: `index.mjs`, `runtime.mjs`, `store.mjs`, `vault.mjs`, `local-agents.mjs`, `integrations.mjs`, `messenger.mjs`, `agent-profiles.mjs`, `agent-onboarding.mjs`, `agent-scheduler.mjs`, `host-discovery.mjs`. Values are computed from the running source at server creation, not hardcoded release claims. A build ref or old test count cannot replace reading these fingerprints back from the actual packaged runtime.

## Messenger contracts

`messenger.mjs` adds contacts, stable direct conversations, group membership/response policies and the cross-conversation approvals projection. The exact routes, schemas, persona snapshots, post-join visibility and local-only human delivery are specified in [Personal contacts and messaging](../../../docs/api.md#personal-contacts-and-messaging). Chat messages bind their own contact backend on the server; unlike old task requests they cannot be redirected by renderer execution fields. The old task APIs below remain compatible.

Group reading is concurrent across independent members and sequential per conversation/agent. Shared remote endpoints serialize using accepted transport snapshots, including uncertainty barriers when contact chat shares a service. Original-task read-only reconciliation can proceed without repeating submission. Legacy routing and approved creation steps remain exclusive. A newly addressed message supersedes only that agent's pending preview. Retry inherits the original identity, visibility and private transport binding. A2A contact chat sends its scoped context directly; MCP planning uses that same visibility boundary once. A changed endpoint or credential binding blocks dispatch and retry. Old pending decisions remain explicit. Chat assistant outputs do not feed a new dispatch loop. Remote chat replies display their returned text directly; provenance and verification scope stay in run/artifact records.

## MCP action and readback

`decisions.mjs` owns request/respond/read and the private worker claim/observation seam; `decision-views.mjs` gives thread and inbox callers the same capabilities and four independent facts. The trusted route supplies owner identity. MCP can add `grantDuration:"conversation_exact"` to approve, and `{action:"revoke",version,clientId}` revokes future uses. `decision_grant` and `decision_attempt` remain private documents. Claim rechecks exact scope, identity, payload and schema in the same transaction that consumes a use and persists Attempt, before I/O. A claim committed before revocation may execute; one committed after it cannot. Restart keeps uncertain attempts without replay. Provider answers never create these grants, and their acceptance never proves action completion or verification.

Supported MCP revisions are `2025-03-26`, `2025-06-18`, and `2025-11-25`: `initialize`, `notifications/initialized`, `tools/list`, and approved `tools/call` over Streamable HTTP. Both JSON and a matching JSON-RPC result within SSE are supported. Session IDs and negotiated versions are retained in the private store; session IDs are omitted from browser connection records. A 404 during tool discovery can establish a new session; a tool mutation is never automatically resubmitted. Optional Bearer authorization covers initialization, the initialized notification, discovery, calls, and readback. Server-initiated requests, 2026 protocol revisions, OAuth, and arbitrary authentication headers are not implemented.

Advanced clients may send this instead of asking the planner to construct the action:

```json
{
  "toolName": "set_value",
  "arguments": {"key": "explicit-owned-key", "value": "expected-value"},
  "verification": {
    "toolName": "read_value",
    "arguments": {"key": "explicit-owned-key"},
    "expected": {
      "path": "/structuredContent/value",
      "equals": "expected-value"
    }
  }
}
```

Both calls and the expected comparison appear in the approval. `expected.path` is a JSON Pointer into the full readback result. Without `expected`, a readback is an observation, not proof of the desired effect. Without any readback, `verificationState` is `not_provided`. `isError: true` fails the task; mismatched readback blocks it. Neither result can be labeled completed. A failure receipt can still be preserved as an artifact.

The primary artifact displays the service's `content` text directly, preserving its Markdown headings, tables, code, and links. Source service URL, tool name, and the limited verification scope accompany it. Nontext results are described accurately and public web resource links are retained; no document or directory is invented. Complete **credential-redacted original results** remain in `run.remoteReceipt.result`, with optional credential-redacted readback in `run.remoteReceipt.readback.result`, for expandable execution records. Known Bearer strings echoed by a service are removed before persistence, prompts, payloads, and API output. Projection makes no additional model call.

Tool-name and top-level required/type/enum checks reject malformed plans; they are not a complete JSON Schema validator or a security boundary. The remote server remains responsible for its actual tool authorization and schema enforcement.

## Persistence, uncertainty, and receipt scope

The service owns a durable single-process queue. SQLite WAL with `synchronous=FULL` stores threads, decisions, idempotency records, and immutable artifacts; a separate SQLite connection holds an OS-backed `BEGIN EXCLUSIVE` worker lock. The service never unlinks that lock inode or opens/closes it through ordinary filesystem descriptors. Directory permissions are 0700; database, WAL, shared-memory, and lock files are 0600. Browser closure does not stop work. A second process using the same directory is rejected.

Queued work resumes after restart, subject to preceding unresolved runs. Interrupted local organization becomes `blocked` and can be retried. Interrupted Codex or remote execution becomes `unknown`; mutations that may have been submitted are not replayed. An A2A taskId is retained for read-only reconciliation, and every `tasks/get` result must match that exact taskId and task shape. Without a known taskId, inspect the original remote system before creating another action. A local cancel does not claim the remote effect was canceled: an unresolved remote run retains `requiresReconciliation`, and the thread remains `unknown` while its saved followups wait. A canceled local Codex process allows its queued followups to continue. Late results cannot revive a canceled run, and replaying an old cancel cannot cancel a later run because its process effect remains bound to the original run ID.

`decision.decision` records the person's choice. `deliveryState` records transport, `actionState` records the returned execution status, and verification fields describe their limited evidence:

- `run.verification.scope: "local_artifact_readback"` means the saved Markdown was read back and its SHA-256 matched. This is never evidence of a remote account or side effect.
- A2A `run.remoteVerification.scope` is `a2a_tasks_get` or `a2a_message_response`. It records the remote protocol response; `externalEffectsVerified` remains false. A2A decision `verificationState: "verified"` refers to the locally saved artifact, not an independent external acceptance.
- MCP `run.externalVerification.scope: "mcp_explicit_readback"` records the approved readback and optional expected-field match. `externalEffectsVerified: true` is limited to that reported JSON field matching the approved expected value; it does not prove unrelated external effects.

## Local access and authentication limits

The server trusts the owner of this Mac and has no separate multi-user login. It checks loopback Host/Origin, rejects cross-site browser requests, and does not allow arbitrary network binding. It is not a hosted or LAN service. Connection URLs cannot contain credentials, query parameters, or fragments; non-loopback endpoints require HTTPS. A2A `configured` means its address was saved, not that its health or account identity was verified. MCP creation performs a real initialization handshake. Real authenticated accounts require separate acceptance; synthetic local protocol tests do not establish it.

Bearer is the only supported HTTP connection credential. Optional `token` accepts 8–8000 visible ASCII characters with no whitespace, CRLF, or control characters; omission or `""` means unauthenticated. Explicit JSON `null` is invalid (400 `invalid_bearer_token`), not a request to remove or reuse a credential. Arbitrary header configuration and generic OAuth are unsupported. Native service-specific login is separate and exposes no saved credential through its progress IPC. Authorization is added only on the server's request to the configured endpoint, with redirects disabled. Token strings are never placed on connection objects, thread/decision payloads, model catalogs, logs, or public API records. Public connections expose only `auth:{type:"none"|"bearer",configured,identityVerified:false}`. Approval previews expose `identity:{label,authentication,identityVerified:false}`; the user-entered label is not a verified remote username. A native loopback token authenticates the local adapter, not independent ownership of the provider account; the default UI uses the personal Agent name and keeps the full URL in technical details.

`vault.mjs` encrypts immutable credential records with AES-256-GCM, a fresh nonce per record, and authenticated connection ID/type/endpoint/version binding. Each workspace has its own 32-byte `vault/master.key`; encrypted records are under `vault/credentials/`. Files are 0600 and directories 0700. Creation uses an exclusive atomic link and file/directory fsync; existing keys or records are not overwritten on failure. A key is generated only in a Git-ignored location or outside a Git repository. Missing, damaged, or unreadable keys/records block credential use; they do not trigger replacement-key generation over existing credentials. A failed connection handshake removes its newly created credential; a failed duplicate request cannot replace an existing account. Safely deleting an unused connection removes its encrypted record, while unresolved tasks preserve the account's reconciliation channel. Filesystem cleanup failure leaves encrypted data for a retry rather than deleting another account's credential.

This vault is **not Keychain** and does not isolate credentials from processes already running as the same OS user. Protect the master key and encrypted records together in backups; losing the original key makes the records unusable. No credential-agent or sandbox separation is claimed. The CLI's actual configured permissions remain the boundary described above.

Private stable `credentialRef`/version and keyed fingerprints are omitted from browser records and model context. A different token on the same endpoint creates a separate connection; credentials on an existing connection are not silently rotated or overwritten. A private decision binding checks connection ID, endpoint, credential reference, and version before dispatch, so an old approval cannot authorize a different credential identity. Remote account identity and permissions are determined by the submitted token and the remote service. There is no general account-identity proof endpoint, and `identityVerified` remains false.

Protocol references: [MCP 2025-11-25 transport](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/transports.mdx), [SQLite POSIX lock descriptor caveat](https://www.sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_).

## Pi profiles and live answer protocol (GET-485)

Pi metadata uses no-prompt RPC `get_available_models`, with tools/extensions/context files disabled, an independent 2 MB private budget and stdin closed only after its response. Only model identifiers, labels, capabilities and supported thinking levels leave the adapter. Saved `settings.json` and selected model defaults are reread; auth files are not read by AgentRoom. Identity preview is a separate explicit operation.

Pi execution pins provider/model/thinking and uses JSON print, no session/tools/extensions/skills/prompt templates/themes/context files/approval, and offline startup. Offline startup does not disable the selected model network call. Visible `text_delta` events supply bounded UTF-8 progress; thinking only changes a coarse phase. Success requires final assistant `stopReason:stop`, matching model/provider, `agent_settled`, nonempty text and exit zero. Exit zero with an error message is a failure. Codex JSON item progress and supported Claude stream-json progress use the same per-run path. Full details and contact configuration are in the [API contract](../../../docs/api.md#live-local-conversations-get-485).

## IM participation

Versioned IM preferences default to allowing silence; groups can override the setting and accepted runs freeze it. Auto local agents choose validated text, reaction or silence output. Direct chat remains Markdown compatible, with optional structured reaction/silence. Reactions target the input message, preserve identity and visibility, carry artifact dependencies, and never invoke peers. Input receipts distinguish supplied context from acknowledged completion; group UI does not reserve a reply slot for every queued reader. See the [API contract](../../../docs/api.md) and [acceptance ledger](../../../docs/personal/concurrent-im-acceptance.md).

## Tailscale server nodes

`agent-node.mjs` is the independent server execution boundary; `dev/agent-node.mjs` initializes private state and runs it without pnpm dependencies. `remote-nodes.mjs` handles authenticated desktop enrollment and belongs in the desktop copied-runtime list and runtime source fingerprints. It does not expose the personal HTTP API remotely. See [setup and lifecycle](../../../docs/personal/remote-nodes.md).
