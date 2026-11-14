# AgentRoom API contracts

## Agent-callable chat tools (GET-542)

The private, per-run tool catalog includes `list_contacts`, `list_rooms`, `get_room_members`, `read_messages`, `search_messages`, `create_room`, `add_room_member`, `send_message` and `send_direct_message`. Their exact JSON schemas live in `apps/personal/server/chat-tools.mjs`. Local Codex/Claude/Pi use the existing ToolSessions transport. Scheduled, onboarding, device-request and artifact-work runs cannot initiate chat tools; valid inherited read dependencies can still be used in scheduled replies.

Directory results contain adopted public identities only, without instructions, bindings or credentials. Room/history reads require the caller and the source conversation's entire accepted audience to share the target room and each message. All current membership epochs and join boundaries apply. Current-chat reads stop at the accepted owner input; later follow-ups are excluded. Pages are limited to 50 messages and 24,000 characters, with `truncated` and `nextBefore` indicators. Read dependencies propagate through messages/reactions, creation cards, approved work and MCP requests and are rechecked before use/publication.

Write tools return `{status:"pending_approval",decisionId,notice}`. They create `kind:"chat_action"` decisions in the source conversation without changing its run's dispatch state. Owner `POST /api/decisions/:id` uses the existing `{choice,version,clientId}` contract. Approval atomically rechecks source/target identities, membership and target version, applies the exact operation and saves `result:{status,threadId,title,messageId,deliveryState,scope,agentsWoken}`. Rejection changes no room or message. Replays return the original result. Completed chat decisions remain separate from A2A/MCP dispatch and survive recovery while the source model is running.

Groups explicitly include the owner and requesting Agent. Invitations add adopted Agents with post-join history boundaries. Messages are saved as the requesting Agent, never as the owner, without automatically waking other Agents. `send_direct_message` uses a dedicated owner-visible Agent collaboration room; it does not read or reuse the owner's private DM with the recipient. Human remote delivery remains unavailable. An owner-approved exact text copy carries a specific forwarding grant; it does not grant access to other source history. Artifact-derived text additionally requires existing artifact sharing for the target audience.

A2A/native-service chats receive `agentroomTools:{tools,protocol}` and bounded `toolResults` in their request. A provider may return only `{"action":"tool_call","name":"list_contacts","arguments":{},"callId":"stable-id"}` to request one host-mediated round. At most eight rounds are allowed. A write result is an approval request, not execution. Remote calls receive no local tool bearer token or callback endpoint. Each continuation persists a distinct `dispatchMessageId`, original task receipt and result transcript. Unknown delivery is reconciled against that exact round, never resent. Completed-but-unsent continuations can resume after restart. Result history is capped at 40,000 characters; requests exceeding the existing native 100,000-character limit are rejected before dispatch.

## Nango and chat-scoped MCP tools (GET-538)

| Route | Owner input / result |
| --- | --- |
| `GET /api/mcp/access` | `{connections:[{id,name,access}],contacts:[{id,name,localAgentId}],threads:[{id,title,kind,memberIds}]}`; no conversation bodies, endpoints or credentials in this catalog |
| `POST /api/mcp/access/:connectionId` | `{version,enabled,contactIds,threadIds,threadContactIds?,toolNames,clientId?}` → versioned access setting; new connections start disabled |
| `POST /api/integrations/nango` | `{baseUrl?,apiKey,integrationId,connectionId,toolNames?,clientId?}` → public MCP connection with `nango:{integrationId,expiresAt}` |
| `GET /api/integrations/nango/recovery` | Sanitized interrupted-session, revocation and local credential-cleanup status; no credentials |
| `POST /api/integrations/nango/recovery/:id/retire` | `{clientId?}` → retire a locally owned recovery record after checking Nango; no remote request; active operations cannot be retired |
| `POST /api/integrations/nango/:id/renew` | `{clientId?}` → replacement scoped session on the same local connection ID; credentials rotate, older approvals lose validity |

Access requires the enabled connection, selected conversation, and an allowed local contact. `contactIds` supplies the default agents for the selected conversations; `threadContactIds[threadId]` replaces that list only in one conversation. An empty override allows no agents. Tool names are exact matches; an empty `toolNames` list permits the connection's discovered tools. Settings are visibility and request scopes, never permission to execute without a Decision. Version/identity/membership are checked again in the dispatch transaction. Thread overrides may only name local agents in that conversation. Lists are bounded; changes invalidate older requests conservatively.

Codex, Claude Code and Pi receive the two private broker tools `mcp_search({query?,connectionId?,connectionCursor?})` and `mcp_request({connectionId,catalogFingerprint,toolName,arguments,verification?})`. The server owns their thread/run/contact identity. Discovery saves actual catalog evidence; a model-supplied hash is insufficient. Results are limited to 20 tools / 128 KB, with `truncated`, service pagination through `nextConnectionCursor`, and an invitation to narrow the query. Parent completion releases full discovery catalogs; only the selected tool contracts remain on accepted requests. Complete provider catalogs are limited to 1000 tools, 20 continuation cursors and 2 MB; repeating cursors and incomplete catalogs fail explicitly.

`mcp_request` creates a distinct attributed MCP run on the same accepted message and returns `{runId,state:"approval_required",executed:false,message}`. Up to ten requests per parent run are allowed. The durable idempotency key binds the original parent and tool call ID. The existing Decision preview, claim, Attempt, response and optional readback perform the eventual action; the result appears as the requesting Agent's message in the original conversation. Normal parent completion preserves requests; explicitly cancelling the parent cancels unclaimed children. It does not automatically restart a model after a tool result or broadcast to all agents. Unknown external results remain unreplayed after restart.

Nango uses the documented Agent Sessions API: `POST /sessions`, exactly one pinned integration/connection, 1h expiration, optional tool allowlist, search/execute enabled, proxy and dynamic connection creation disabled. Administrator keys and session tokens use separate vault bindings. All returned MCP URLs must remain on the configured API origin and match the returned session ID. This requires a Nango environment supporting Agent Sessions; an existing scoped MCP URL/token can also use generic connection setup. Renewal is explicit. A failed/uncertain creation retains its original request identity; after checking the original operation in Nango, the owner may explicitly start a new request. No automatic retry or session rotation happens behind a pending approval. A durable staging journal owns credentials before remote creation; restart can attach a verified candidate to its recovery metadata without a network call. Interrupted renewal preserves the original connection; unresolved creation remains visible for reconciliation. Local rotation success and pending old-session revocation are committed atomically, so a crash during remote revocation cannot erase the successful rotation receipt. Unconfirmed disconnects also retain recovery records across restart. Explicit local retirement releases the final unshared administrator credential without retrying any remote operation. Deletion locally revokes access and reports remote session revocation separately; an in-flight call is not undone.

Grok/Muse/Dots/Cue and A2A agents keep their provider-owned tools; AgentRoom does not forward these local capabilities or credentials to them. These routes use the same fixed desktop IPC whitelist as existing personal APIs.

Personal bootstrap `workspace.guide` is null for existing profiles without a guide, otherwise `{contactId, threadId, agentId, providerName, reason, executionVerified:false}`. First-use bootstrap creates one persistent Roo DM using existing contact/thread storage; refresh never runs a model. Guide DMs include a bounded accepted host/config/contact snapshot in their execution context. Existing contact, connection and onboarding routes perform adoption and approvals; no generic filesystem or installer capability is exposed.

## Workspace onboarding and native test profiles

- `GET /api/bootstrap` includes `workspace: {onboardingCompleted, displayName}`. Existing populated workspaces are adopted without forced first-use UI.
- `POST /api/workspace/onboarding`: `{action:"complete", name, clientId}` saves a trimmed 1–80 character owner name and completion marker atomically; `{action:"restart", clientId}` reopens onboarding without clearing other data. Unknown fields/actions are rejected.
- `GET /api/workspace/status`: `{blockingRuns}` counts queued, active, approval-pending, unknown and unresolved runs, plus unresolved creation proposals, capability requests, collaboration work and unknown owner file operations.
- `agentstudio:personal:test-workspace` is a trusted personal-document-only native IPC action, with exactly `enter|reset|leave`. Preload exposes readonly `testMode` and `testWorkspace(action)`. No paths or commands are accepted. No HTTP profile-reset capability is exposed. The private utility message freezes writes/scheduling and checks existing work before confirmed shutdown and relaunch.

See [test-mode boundaries](personal/testing.md).

## Coauthored artifact capabilities

These personal owner routes are allowlisted in native IPC. Agents use scoped native tools instead of these owner routes.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/api/library/artifacts` | Workspace artifact metadata; stable `aw_…` IDs |
| GET | `/api/library/artifacts/:id` | Artifact, chronological committed revisions, contributions, group links, private work/permissions and owner operations |
| POST | `/api/library/artifacts/:id/files` | `{revisionId, path?}`; verified UTF-8 files and hashes, never arbitrary filesystem paths |
| POST | `/api/library/artifacts/:id/preview` | `{revisionId}`; opaque, expiring, checked revision capability |
| GET | `/api/library/previews/:opaqueId` | Exact file mapping; only available in the owning utility lifetime |
| GET | `/api/library/previews/:opaqueId/files/:fileId` | Verified single file and host MIME type |
| POST | `/api/library/artifacts/:id/share` | `{threadId, revisionId, paths, follow:false, clientId}`; snapshot current audience; `{threadId,revoke:true,expectedVersion,clientId}` withdraws a link |
| POST | `/api/library/artifacts/:id/change` | `{action,expectedVersion,clientId,…}`; `edit` adds `path,text,expectedHash`, `restore/accept` add `revisionId`, plus `import-local/archive/unarchive`; `reconcile-owner` requires `operationId,confirmedReviewed:true` to abandon an unconfirmed receipt after review |
| POST | `/api/library/artifacts/:id/resolve-local` | `{action:"preserve-and-update",clientId}`; retain local backup before adopting head |
| GET | `/api/threads/:id/creation` | Audience-safe proposals, fixed work/request status, authorized links and up to 100 indexed tool receipts; no private work free text |
| POST | `/api/creation-proposals/:id/decision` | `{version,choice:"approve|reject",clientId}`; approve requires `ready`; reject accepts `ready` or `needs_input` without starting work |
| POST | `/api/creation-proposals/:id/change` | `{version,goal,tasks?,paths?,dependencies?,clientId}`; edits own roles and regenerates canonical version |
| GET | `/api/capability-requests/:id` | Owner-only precise scope, purpose and recipients |
| GET | `/api/collaborations/:id` | Owner-only work, step details, handoffs and attempts |
| POST | `/api/capability-requests/:id/revoke` | `{version,clientId}`; revoke extra work grant and stop dependent work |
| POST | `/api/capability-requests/:id/decision` | `{version,choice:"approve|reject",clientId}`; precise extra scope, resume preserved step |
| POST | `/api/collaborations/:id/control` | `{action:"stop|retry|reconcile",stepId?,runId?,choice?,confirmedStopped?,clientId}`; unknown reconciliation requires exact latest step/run and confirmedStopped:true, then abandon or adopt_saved; no blind replay |

`GET /api/threads/:id` also includes the same `creation` metadata for cards. The original `/api/artifacts/:id` immutable Markdown routes retain their existing meaning.

Native `artifactAction({kind:"reveal|export",artifactId,revisionId?})` accepts only opaque IDs. Main computes the current folder itself or uses a native directory dialog to export verified revision files into a new directory; credentials and transcripts are excluded. The `agentroom-artifact:` handler maps only preview capability/file members, adds CSP sandbox and denies network capability. Main's hidden-window verdict uses a private parent/utility message and has no renderer HTTP/IPC verdict endpoint.

Discussion tools: `artifact_list/read`, `creation_propose/update`, `permission_request`, `collaboration_status`. `creation_update` can join another participant's existing draft by its current ID/version without restating the global artifact kind. Approved work also has `task_claim/delegate/yield`, `collaboration_message`, `artifact_write/submit/check` and `task_complete`. Every write includes the expected file SHA-256 (null for creation). Sessions bind trusted run/contact/backend/grant context, deduplicate call IDs, and revalidate cached reads after scope changes. Only a pre-execution unsupported-capability failure may retain the same backend's ordinary read-only chat path. See [full boundaries](personal/artifact-coauthoring.md).

## Default personal desktop IPC

The Mac app's default personal renderer calls `window.agentStudioPersonal`, exposed only by its dedicated preload. The shared source of types is `apps/personal/src/desktop-contract.ts`; desktop re-exports it in `src/shared/personal-api.ts`. The built renderer is a trusted local file, has no API HTTP connection permission, and cannot use the retained Matrix session/connector bridge.

```ts
type DesktopCommand = "new" | "search" | "settings"
type DesktopMethod = "GET" | "POST" | "DELETE"
type PersonalServiceId = "grokbot" | "muse" | "dots" | "cue"
type NativeIntegrationRequest =
  | {kind: "services"}
  | {kind: "connect"; serviceId: PersonalServiceId}
  | {kind: "progress" | "cancel"; flowId: string}
  | {kind: "choose"; flowId: string; choiceId: string}
  | {kind: "submit"; flowId: string; value: string}
  | {kind: "open" | "remove" | "reconnect"; instanceId: string}
  | {kind: "local-login"; agentId: "codex" | "claude"}
  | {kind: "local-login-status" | "local-login-cancel"; flowId: string}
type NativeIntegrationReply = {
  state: "catalog" | "waiting" | "choose" | "input" | "ready" | "failed" | "cancelled"
  flowId?: string; message?: string
  providers?: {id: PersonalServiceId; name: string; description: string}[]
  instances?: {id?: string; instanceId?: string; service?: PersonalServiceId;
    name: string; status?: string; canOpen?: boolean; connectionId?: string; avatarDataUrl?: string}[]
  connectionIds?: string[]
  actions?: {id: string; label: string}[]
  choices?: {id: string; label: string}[]
  label?: string; secret?: boolean; error?: string
  link?: {label: string; url: string}
}
interface PersonalDesktopBridge {
  readonly platform: string
  readonly version: string
  request(input: {path: string; method: DesktopMethod; body?: unknown}):
    Promise<{status: number; body: unknown}>
  onChanged(listener: () => void): () => void
  onCommand(listener: (command: DesktopCommand) => void): () => void
  saveArtifact(id: string): Promise<{
    cancelled: boolean; fileName?: string; path?: string; sha256?: string
  }>
  artifactAction?(input: {kind:"reveal"|"export";artifactId:string;revisionId?:string}): Promise<{cancelled:boolean;path?:string}>
  copyPlayInvitation?(input: {roomId:string;local:boolean}): Promise<void>
  restart(): Promise<void>
  nativeIntegration?(request: NativeIntegrationRequest): Promise<NativeIntegrationReply>
}
```

Native `services` catalog instances may include `avatarDataUrl`, a main-generated PNG data URL (at most 512,000 image bytes, 256 px maximum side). Provider photo URLs, authentication and filesystem paths are never returned. An unavailable avatar is omitted. This is presentation metadata, separate from contact configuration and model context; see [Grok Bot avatars](personal/grok-bot-avatars.md).

`request` accepts only the following fixed paths; IDs are opaque, without URL syntax. Queries, arbitrary URLs/headers, file paths and shell commands are rejected. POST requires a JSON object of at most 2 MB; GET/DELETE accept no body.

| Method | Paths |
| --- | --- |
| GET | `/api/health`, `/api/bootstrap`, `/api/contacts`, `/api/contacts/:id`, `/api/contacts/:id/control`, `/api/host/discovery`, `/api/approvals`, `/api/integrations`, `/api/connections`, `/api/memories`, `/api/threads/:id`, `/api/artifacts/:id`, `/api/connections/:id/tools` |
| POST | `/api/contacts`, `/api/contacts/:id`, `/api/contacts/:id/control`, `/api/contacts/:id/run`, `/api/chats`, `/api/chats/:id`, `/api/threads`, `/api/connections`, `/api/memories`, `/api/integrations/refresh`, `/api/integrations/connect`, `/api/integrations/local/codex`, `/api/integrations/local/claude`, `/api/threads/:id/messages`, `/api/threads/:id/read`, `/api/threads/:id/retry`, `/api/threads/:id/reconcile`, `/api/threads/:id/cancel`, `/api/decisions/:id` |
| DELETE | `/api/connections/:id`, `/api/memories/:id` |

Main forwards to its own utility's random loopback port after validating the sender document and ownership handshake. There is no renderer route for SSE or artifact download: `onChanged` invalidates the UI snapshot, and `saveArtifact` uses a native dialog plus byte/hash readback. Runtime restart does not replay POST requests. `GET /api/health` includes the build reference, backend/UI hashes and desktop runtime versions.

Personal JSON uses **camelCase**, independently of the Matrix `/v1` contract below. `POST /api/threads` and `POST /api/threads/:id/messages` accept `{text,clientId,mode?,localAgentId?,connectionId?,attachments?,memoryIds?,action?}` and return the full thread. `localAgentId` accepts `codex` or `claude`; when omitted, the server snapshots the saved local selection (default `codex`) into the accepted run. `mode: "codex"` remains the compatibility name for automatic local routing and can use either adapter. Changing the default does not change an accepted run. `clientId` identifies an immutable request: same route/key/body returns its accepted receipt, even if a selected memory or completed connection was later removed; changed content returns 409. New requests validate current dependencies. Decisions require `{choice,version,clientId}`. Followups are durable sequential runs with context ending at their own message ID. Unknown execution blocks replay and later runs; an unconfirmed CLI stop also blocks new work using that same local assistant across threads.

### Personal contacts and messaging

The default personal homepage is an IM. Its contacts and conversations live in the same profile database as existing tasks; no Matrix data is imported. All mutations below require `clientId` (same body replays the accepted response, changed body returns 409).

| Route | Contract |
| --- | --- |
| `GET /api/contacts` | `{contacts}`; refreshes bounded local discovery and projects saved connections; preserves user-edited identity fields |
| `GET /api/contacts/:id` | One contact, including configured persona, backend binding, capability and login status; not proof of provider identity |
| `POST /api/contacts` | `{clientId,kind:"agent"\|"human",name,handle,description?,instructions?,color?,icon?,configuration?,binding?}`; returns contact. Agent binding is `{type:"local",localAgentId}` or `{type:"connection",connectionId}`; human contacts are local-only |
| `POST /api/contacts/:id` | Same identity fields plus current `version`; updates increment version, stale writes return 409. Discovered contacts retain their backend |
| `POST /api/chats` | `{clientId,kind:"direct"\|"group",memberIds,title?}`; adds `self`. A direct chat reuses the peer's existing conversation. New groups require a title and at least two distinct other contacts (three members including `self`); otherwise 400 `group_min_members`. Creation never runs a model |
| `POST /api/chats/:id` | Group only: `{clientId,version,title?,memberIds?,responsePolicies?:{[contactId]:"auto"\|"mention"\|"always"\|"manual"}}`; maximum 30 supplied members. New members receive only post-join material |

For compatibility, group create/update still accepts legacy `groupAvatar` metadata; the current UI always renders member portraits and offers no custom-portrait controls. Ordinary UI edits omit this field to preserve stored metadata. Accepted legacy values are: `null` for the illustrated default, `{kind:"preset",icon,color}` for a motif/color, or `{kind:"image",dataUrl}` for a local picture. Motifs are `room`, `spark`, `code`, `compass`, `leaf`, `coffee`; colors are `teal`, `blue`, `violet`, `orange`, `rose`. The server accepts only a structurally bounded square PNG data URL (≤256×256, ≤96 KiB decoded), rejects remote/SVG URLs and unknown fields, and preserves an omitted value during edits. The group metadata is returned in full threads and bootstrap summaries. Direct chats cannot accept group avatars. The existing version check and idempotency apply; changing/resetting a portrait does not alter member visibility, messages, pending decisions or accepted execution inputs. Legacy stored pictures contain no source image metadata.
| `POST /api/threads/:id/messages` | For chat threads: `{clientId,text,attachments?,memoryIds?,replyTo?}`. Server selects bound agents; caller cannot redirect via `mode`, `connectionId` or `action`. Stores one user message and zero or more runs |
| `GET /api/approvals` | `{approvals}`; pending first, with original `threadId`, `threadTitle`, accepted contact identity (or the linked provider contact for standalone cards), and public `source:{label,name,connectionId,botId,requestText,threadKind}`. Bot IDs come only from the owned native source; request text comes only from the decision's run/message binding. Missing records return null fields. Choices still use `/api/decisions/:id` with current version and a separate idempotent request |

Contacts have unique 2–32 character lowercase handles (`[a-z][a-z0-9_-]{1,31}`), an identity version and `availability` (`ready|configuration_required|unsupported|not_installed|login_required|disconnected|local_only|self`). Names are at most 80 characters, descriptions 300, persona instructions 3000. Discovered contacts retain the complete provider label as `sourceName` and its naming policy as `nameSource:"provider"|"custom"`. Provider labels use a short heading where available, otherwise a service label plus six stable identifier characters; automatic names occupy at most 28 display units (ASCII one, other graphemes two). Saving an explicit name pins it as custom. Legacy edited or ambiguous names are preserved. Discovery increments the identity version when it changes the visible name, without rewriting accepted snapshots. This version discovers Codex, Claude Code, Pi, Gemini CLI and OpenCode; Codex, Claude and Pi have executable local adapters. A connection removed later remains a visibly disconnected contact rather than silently rebinding it.

Private agents respond directly. Groups default to `auto`: available members receive owner messages, and local agents independently return a validated reply, reaction or silence decision based on persona, conversation and explicit `@handle`/reply attention. Silence and reactions complete without a text message or document artifact; malformed output remains a failure. Explicit `mention`, `always` and `manual` policies remain available, with `@all` for executable members; paused members never auto-respond. Agent replies never enqueue agents. Unavailable or uncertain broadcast members are skipped with `message.skippedContacts`; a direct or explicit unavailable target returns 409 before accepting the message. Per-agent lanes let other members continue while one awaits approval or reconciliation; a new addressed message invalidates only that agent's old previews. The same run keeps its accepted persona, participants, visibility boundary and backend on retry. Accepted A2A contact chat sends the filtered conversation/identity payload directly, without a decision or approval card; ordinary remote replies use the same plain reply presentation as local agents. A private endpoint/credential snapshot is captured at acceptance and preserved on retry; a changed binding blocks dispatch. Existing pending decisions, legacy task forwarding and MCP tool calls retain exact approvals. MCP planning uses the same filtered context. Joining does not grant earlier history or other conversations. Prompt boundaries do not override the CLI's actual configured plugin permissions.

IM reading uses one durable queue with up to three independent invocations by default. Each conversation/agent retains order; accepted A2A/MCP endpoints share conservative active session lanes. Pending approval does not occupy a worker slot. A contact chat cannot submit across unknown work on the same accepted endpoint (including legacy work), and legacy submissions cannot cross contact-chat uncertainty. Independently approved legacy task-to-task behavior remains compatible. Original-task read-only reconciliation may cross historical unknown barriers but still holds the active session lane. Legacy dynamic routing and approved artifact creation steps retain exclusive execution. Endpoint ownership comes from private accepted transport snapshots, not later connection edits.

`GET /api/im/settings` returns `{version,allowSilence}` (default true); `POST /api/im/settings` takes `{version,allowSilence,clientId}`. `POST /api/chats` and `POST /api/chats/:id` accept optional `allowSilence:boolean|null` (null inherits IM settings). Each accepted contact run freezes `imPolicy`; `always` requires a response. Auto local groups require `{action:"reply",text}`, `{action:"reaction",emoji}`, or `{action:"silence",reason}`. Ordinary direct/explicit local replies and remote chat remain Markdown compatible; contact chat may use supported reaction/silence envelopes. Silence disabled rejects a silence envelope instead of fabricating a reply. Failures never become silence.

`POST /api/threads/:id/reactions {messageId,emoji,active,clientId}` adds/removes only the owner's reaction and is idempotent. Supported emoji are `👍 ❤️ 😂 🎉 🤔 👀 ✅`. Agent reaction output targets only its run's input message, deduplicates by actor/emoji and preserves identity/run/audience records. Reactions carry source dependencies through later readers; final publication rechecks artifact authorization and membership epoch. They do not wake agents.

At dispatch each contact run records `inputReceipt:{state:"supplied",messageIds,suppliedAt}` for its exact visible context. Valid completion changes it to `acknowledged` with `acknowledgedAt`; startup, transport acceptance, errors and cancellation do not acknowledge reading. The receipt records supplied context and a valid response, not semantic understanding. Dispatch may include already published peers answering the same input without waiting for unfinished peers. Later owner messages, pre-join material, other chats and excluded audiences remain invisible. Membership epochs prevent old output from reaching a removed/rejoined member.

Human contacts and their messages currently stay on this Mac. `deliveryState:"local_only"` is not remote delivery. Existing task threads continue in the same IM shell through their original `/api/threads/:id/messages` endpoint. Old `?workspace=tasks&thread=:id` links open that same shell. Their old draft keys are retained as backups; the renderer reconstructs original unconfirmed requests without changing their clientId, fingerprint, memory snapshot or create/message route.

### Local contact adoption

`POST /api/contacts/local` accepts exactly `{agentIds,clientId}` and returns `{contacts}` (200). Select 1–5 entries from `codex|claude|pi`; duplicates coalesce. The server forces current local discovery, validates the entire selection as installed and supported, then atomically adopts the stable `agent_<id>` contacts. Login or model configuration can remain incomplete and is reported in availability. No model, login, installation, global-default change or message send occurs. Same request key/body replays its receipt; changed body returns 409. Unknown fields return 400; unavailable installation/support returns 409. The existing fixed contact POST IPC route allows this capability.

`GET /api/contacts` remains the complete contact/backend inventory for editors and compatibility. Newly discovered local contacts have `added:false` until selected; ordinary address books and member pickers omit those candidates. Existing records without this flag retain visibility (`added:true` on sync), including unavailable contacts and prior chats. Explicitly opening a direct chat adopts its selected candidate. Roles keep separate IDs and can reuse an unadopted backend. Discovery never overwrites user names, instructions or model preferences.

The shared Agent card reads `agentInfo:{model,provider,thinking,source,checkedAt,quota}` for local assistants, enrolled nodes and direct A2A services. These are next-message configuration or dated service observations, not execution proof. Missing fields remain unknown. Offline observations retain their original timestamps. MCP cards describe the explicit local chat backend; tool-service quotas are not inferred.

`quota` contains `status:available|unavailable`, optional provider, source, checkedAt, reason, up to eight `windows:[{remainingPercent,windowMinutes,resetsAt}]` and optional `credits:{unlimited,balance}`. Percentages, windows, resets and credits come only from a service response; zero remaining is a valid value. Unknown, unsupported, failed reads and provider-managed quotas have distinct descriptions. No currency, price, account identity or inference entitlement is inferred. Fixed models from a different provider do not inherit the default provider quota.

`POST /api/contacts/:id/info {}` explicitly rereads that contact and returns its public contact projection. Nonempty bodies are rejected. Concurrent reads of one contact coalesce. Local metadata uses bounded discovery; Codex quota has a 60-second cache and uses only app-server `initialize`, `initialized` and `account/rateLimits/read`, with no thread, prompt, tool invocation or provider change. Codex quota is queried only for the default OpenAI provider and detected login. Other adapters report unsupported unless they supply usage metadata. Node reads refresh the authenticated directory; direct A2A reads the original same-origin card and requires the endpoint and connection credential binding to remain unchanged. Failed remote reads preserve previous observations; the UI offers retry and does not reset their timestamps.

Node manifests and direct A2A cards may include optional `agentInfo` using the shape above. This is an AgentRoom metadata extension, not a requirement of the A2A standard. Projection rejects malformed values and excludes raw account IDs, tokens, headers and provider payloads. Both source and receiving AgentRoom must support the extension to show remote configuration; old peers remain compatible with unknown fields. No new execution capability follows from advertising metadata.

### Personal discovery and quick connections

| Route | Request / response |
| --- | --- |
| `GET /api/integrations` | `{checkedAt,agents,selectedLocalAgentId,presets,ccSwitch}`; fixed Codex/Claude/Pi/Gemini/OpenCode discovery, Codex/Claude/Pi executable adapters |
| `POST /api/integrations/refresh` | `{}` → same response after forced discovery; concurrent discovery coalesces |
| `POST /api/integrations/local/:id` | `{}`, `id` only `codex`, `claude` or `pi` → `{selectedLocalAgentId}`; requires installed, supported and auth `configured`, otherwise 409 |
| `POST /api/integrations/local/pi/identity` | `{}` → explicit bounded preview `{instructions,sources,truncated}` from only Pi global `SYSTEM.md` / `APPEND_SYSTEM.md`; no arbitrary paths or automatic import |
| `POST /api/integrations/connect` | `{presetId,clientId?}` or `{url,token?,clientId?}` → public connection (201); only these four fields are accepted |

Each discovery agent contains `{id,name,installed,version,auth:{status,method?},execution:{supported,reason?},setupUrl,loginCommandId,profile,quota}`. Profile projects only model/provider/thinking metadata, catalog-supported effort levels and a public version; never API headers or credentials. Auth status is `configured|required|unknown|unsupported`; it does not prove account ownership, quota or network validity. Raw probe output, executable paths and credentials are not returned. Presets contain `{id,name,description,account,connectionId|null}` and use the fixed DeepWiki `https://mcp.deepwiki.com/mcp` and Exa `https://mcp.exa.ai/mcp` endpoints. Adding them initializes MCP and lists tools, without calling a tool. The preset request does not accept a nonempty URL or token override.

A custom URL tries a bounded same-origin Agent Card before MCP initialization/tool discovery. A card is metadata, not account proof or an executed task. Cross-origin advertised endpoints are rejected. Remote URLs require HTTPS; HTTP is allowed only on loopback, and credentials/query/fragment in URLs are rejected. `token` is optional: omit it or use `""` for no Bearer; explicit JSON `null`, whitespace, controls, non-ASCII or strings outside 8–8000 characters return 400. Existing advanced `POST /api/connections` remains available. Connection creation with the same optional `clientId` replays its accepted receipt; changed input returns 409. Concurrent identical quick-connect requests share discovery; a saved receipt is replayed before new remote probing. Discovery refresh and selecting the default do not require a `clientId`.

### Fixed native connection actions

`nativeIntegration` is a separate trusted-top-frame IPC capability, not an HTTP endpoint. It rejects extra fields and unknown actions; flow/choice/instance identifiers are bounded opaque strings. `submit.value` is a bounded string, not a command or URL to execute. Main owns personal-service sessions, registers A2A connections with its own backend, and reports ready only after registration. `reconnect` re-registers the named existing native instance; it does not mint a new account or blindly resend a task. `open` requires `canOpen`; `remove` preserves instances with active or unresolved work. A cancel racing with completed login can return ready and tell the user to disconnect the established instance instead.

Native catalog/progress/ready replies contain safe identifiers and labels, not saved service credentials, A2A tokens or A2A endpoint URLs. A user may explicitly submit a new key through a transient password input; it crosses the fixed IPC once and is not part of UI recovery storage or model context. Ordinary public connection records still expose their configured URL without a token. Native `local-login` runs only the fixed vendor login for Codex/Claude; status/cancel target its owned flow, and login completion is followed by fresh discovery, not an account-ownership claim. Auxiliary web clients do not gain this native capability. Lifecycle, isolation and nonreplay details are in [the connector contract](connectors.md#personal-workspace-native-services).

Public connections expose `auth:{type:"none"|"bearer",configured,identityVerified:false}`. Approval identity is `{label,authentication,identityVerified:false}`; the label is not account proof. For a native loopback connection, the UI names the personal Agent and says it connects through this Mac, keeping the full URL in technical details. Its local Bearer authenticates the adapter, not independent ownership of the provider account. A private credential/version binding prevents an old decision from changing identity. Tokens and private references are never public records or model inputs. Data belongs to the selected local personal workspace, without importing Matrix auth. See the [backend API, routing, vault and receipt contract](../apps/personal/server/README.md) for complete request shapes and verification scope. The auxiliary web service uses these `/api` endpoints directly with loopback checks; it is not the native renderer transport.

## Retained Matrix REST API (v1)

The remaining contract applies to `AGENTSTUDIO_WORKSPACE=matrix` and the Expo client.

Base URL: `AGENTSTUDIO_SERVER_URL`, for example `http://127.0.0.1:18090`. All bodies are JSON. Timestamps are RFC 3339 UTC strings. IDs are opaque strings.

## Conventions

- Auth header: `Authorization: Bearer <access_token>`. Every `/v1/*` route requires it except `/v1/auth/*`, `/v1/networks`, `/v1/health` and `/v1/dev/*`.
- Errors use one shape: `{"error": {"code": "snake_case", "message": "Human text"}}`. Codes and statuses:

  | Status | Code |
  |---|---|
  | 400 | `bad_request` |
  | 401 | `unauthenticated` |
  | 403 | `forbidden` |
  | 404 | `not_found` |
  | 409 | `version_conflict` |
  | 410 | `expired` |
  | 422 | `invalid_code` |
  | 429 | `rate_limited` |
  | 502 | `upstream_error` |

- Optimistic concurrency: mutating approvals and tasks requires the current `version`. A stale version returns 409 with the current object in `error.current`.
- Idempotency: a repeated `idempotency_key` for the same user and route returns the original result.
- CORS: the API allows the origins in `AGENTSTUDIO_ALLOWED_ORIGINS` (comma list). Dev mode also allows `http://127.0.0.1:*`, `http://localhost:*` and `null`. The desktop renderer may run from `file://`.
- `/_matrix/*` is reverse-proxied to Synapse unchanged. Clients pass `matrix.homeserver_url` (= base URL) to matrix-js-sdk.

## Health and dev

- `GET /v1/health` returns `{"ok": true, "synapse": true, "bridges": {"demo": true, "agentstudio-agents": true}}`.
- `GET /v1/dev/outbox?email=<email>` returns `{"messages": [{"to", "subject", "code", "sent_at"}]}`, newest first. It exists only when `AGENTSTUDIO_DEV=1`. E2e reads sign-in codes from it.

## Auth

The flow is email code sign-in. Codes are 6 digits, valid for 10 minutes, and stored hashed. A new code is allowed after 30 seconds.

- `POST /v1/auth/email/start {email}` returns 204. In dev mode the mail goes to the dev outbox and to the log.
- `POST /v1/auth/email/verify {email, code, device_name}` returns a `Session`. On a user's first sign-in the API creates the user and its Matrix account.
- `POST /v1/auth/local {device_name}` returns a `Session` for the person on this Mac, without an email code. Only in local mode (`AGENTSTUDIO_LOCAL=1`, which `GET /v1/health` reports as `local: true`), and only for requests from the same machine that no proxy forwarded. The account is always `you@agentstudio.local`.
- `POST /v1/auth/refresh {refresh_token}` returns a `Session`. The refresh token rotates; reusing an old one revokes the session.
- `POST /v1/auth/logout` returns 204. It revokes the session and logs out the Matrix device.
- `GET /v1/me` returns `{"user": User}`.

```ts
type User = { id: string; email: string; matrix_user_id: string; created_at: string }
type Session = {
  session_id: string
  access_token: string          // short-lived, 15 min
  access_expires_at: string
  refresh_token: string         // 60 days; clients keep it in secure storage
  user: User
  matrix: { homeserver_url: string; user_id: string; device_id: string; access_token: string }
}
```

The Matrix account is `@u_<user id>:agentstudio.local`. The API logs in to Synapse with `org.matrix.login.jwt`, signed with `SYNAPSE_JWT_SECRET`, `sub` = localpart. Synapse auto-registers the user and gives each session its own device.

## Networks and connections

Connections are proxied to mautrix bridgev2 provisioning (`/_matrix/provision/v3/...`, shared secret, `user_id` = the caller's Matrix ID). The API adds a `connection_id` and stores connections.

- `GET /v1/networks` returns `{"networks": [Network]}`.
- `GET /v1/connections` returns `{"connections": [Connection]}`.
- `POST /v1/connections/{network}/logins {flow_id}` returns `{"process_id", "step": LoginStep}`.
- `POST /v1/connections/logins/{process_id}/steps/{step_id} {"fields"?: {id: value}, "cookies"?: {id: value}}` returns `{"step": LoginStep}`.
- `POST /v1/connections/logins/{process_id}/steps/{step_id}/wait` returns `{"step": LoginStep}`. This is a long poll for `display_and_wait`, up to 60 s. On timeout it returns the unchanged step; the client polls again.
- `DELETE /v1/connections/{connection_id}` returns 204. It logs out the bridge login and marks the connection removed. Agents on the connection are paused.

```ts
type Network = {
  id: string                    // "demo" | "agentstudio-agents" | "whatsapp" | ...
  name: string                  // "Demo", "Agents", "WhatsApp"
  kind: "chat" | "agent"
  bot_mxid: string
  available: boolean            // bridge reachable
  flows: { id: string; name: string; description: string }[]
}
type Connection = {
  id: string                    // "<network>:<user_login_id>"
  network: string
  remote_name: string           // e.g. "Demo account", "Concierge"
  state: "connecting" | "connected" | "bad_credentials" | "transient_disconnect" | "logged_out"
  state_message?: string
  created_at: string; updated_at: string
}
type LoginStep = {                // mirrors bridgev2 LoginStep, plus AgentRoom's connection_id
  type: "user_input" | "display_and_wait" | "cookies" | "complete"
  step_id: string
  instructions?: string
  user_input?: { fields: { type: "username" | "phone_number" | "email" | "password" | "2fa_code" | "token" | "url" | "domain" | "select"; id: string; name: string; description?: string; default_value?: string; options?: string[] }[] }
  display_and_wait?: { type: "qr" | "emoji" | "code" | "nothing"; data?: string }
  cookies?: { url: string; user_agent?: string; fields: { id: string; required: boolean }[]; extract_js?: string }
  complete?: { user_login_id: string; connection_id: string }
}
```

## Agents

An agent is a contact backed by the `agentstudio-agents` bridge, one agent per connection. The bridge registers agents through the internal API.

- `GET /v1/agents` returns `{"agents": [Agent]}`.
- `PUT /v1/agents/{agent_id}/consent {ask_without_preview: boolean}` returns `Agent`. The setting is per user; "don't ask again" sets it to true.

```ts
type Agent = {
  id: string                    // "<connection_id>"
  connection_id: string
  name: string; description?: string; avatar_url?: string
  room_id: string | null        // the DM room with the agent ghost
  capabilities: ("chat" | "ask" | "approvals")[]
  status: "idle" | "working" | "offline"; status_text?: string
  pending_approvals: number
  consent: { ask_without_preview: boolean }
}
```

## Approvals

- `GET /v1/approvals?state=pending|all` returns `{"approvals": [Approval]}`, newest first. The default is `pending`.
- `GET /v1/approvals/{id}` returns `Approval`.
- `POST /v1/approvals/{id}/decision {choice, version, idempotency_key}` returns `Approval`. It sets state `decided`, delivery `queued`, then delivers to the bridge synchronously (5 s timeout). Delivery ends as `delivered` or `failed`. A decision after `expires_at` returns 410.

```ts
type Approval = {
  id: string; version: number
  agent_id: string; agent_name: string
  room_id: string | null; event_id: string | null   // the card message in the agent room
  title: string                 // "Book the 6pm flight to Toronto for $412?"
  summary?: string
  details: { label: string; value: string }[]
  choices: { key: string; label: string; category: "approve" | "deny" }[]
  state: "pending" | "decided" | "expired" | "cancelled"
  decision: { choice: string; decided_at: string } | null
  delivery_state: "queued" | "delivered" | "failed" | null
  expires_at: string | null
  created_at: string; updated_at: string
}
```

## Tasks ("Ask an agent")

The client creates the task, then sends the ask message into the agent's room. The message has content key `com.agentstudio.ask` with `task_id`; see `docs/matrix-events.md`. The bridge forwards the ask to the agent. Draft replies come back as a `com.agentstudio.drafts` message, and the bridge marks the task `answered`.

- `POST /v1/tasks {agent_id, idempotency_key, request_text, origin, title?}` returns `Task` with state `pending`. `title` is the anchor message text (the API keeps its first line, 80 chars max); without it the title comes from `request_text`.
- `GET /v1/tasks?state=open|all` returns `{"tasks": [Task]}`. `open` means `pending` + `answered`.
- `POST /v1/tasks/{id}/sent {version, draft_index}` returns `Task` with state `done`. The user sent a draft back to the origin chat.
- `POST /v1/tasks/{id}/cancel {version}` returns `Task` with state `cancelled`.

```ts
type Task = {
  id: string; version: number
  agent_id: string; agent_name: string
  state: "pending" | "answered" | "done" | "cancelled" | "failed"
  title: string                 // first line of the anchor message, 80 chars max
  request_text: string
  origin: { room_id: string; network: string; chat_name: string; anchor_event_id: string }
  answer: { event_id: string; drafts: { text: string }[] } | null
  sent_draft_index: number | null
  created_at: string; updated_at: string
}
```

## Internal API (bridges only)

Internal routes authenticate with `Authorization: Bearer <AGENTSTUDIO_INTERNAL_SECRET>` and are never exposed through CORS.

- `POST /internal/v1/bridge-state` receives bridgev2 `status_endpoint` posts (BridgeState JSON, which includes `user_id`, `remote_id`, `remote_name`, `state_event`). The API upserts the connection state. Exception to the internal secret: bridgev2 authenticates this call with its appservice `as_token`, so the API accepts any configured bridge `as_token` here.
- `PUT /internal/v1/agents {owner_mxid, connection_id, name, description?, avatar_url?, capabilities, room_id?}` upserts an agent and returns `Agent`.
- `PATCH /internal/v1/agents/{agent_id} {status?, status_text?, room_id?}` returns `Agent`.
- `POST /internal/v1/approvals {owner_mxid, agent_id, external_id, title, summary?, details, choices, expires_at?, room_id?, event_id?}` returns `Approval`. It is idempotent on (agent_id, external_id).
- `PATCH /internal/v1/approvals/{id} {room_id?, event_id?, state?: "cancelled"}` returns `Approval`.
- `POST /internal/v1/tasks/{id}/answer {event_id, drafts}` returns `Task` with state `answered`.
- `POST /internal/v1/tasks/{id}/fail {reason}` returns `Task` with state `failed`.

The API calls the agents bridge with the same internal secret:

- `POST {AGENTS_BRIDGE_URL}/agentstudio/internal/v1/approval-decisions {approval_id, agent_id, external_id, choice}` returns 200 when delivered to the agent.

## Security notes (v0.1)

- Access tokens are HMAC-SHA256 JWTs (`AGENTSTUDIO_TOKEN_SECRET`). Refresh tokens and email codes are stored only as SHA-256 hashes.
- Matrix tokens are minted per session. Logging out deletes the Matrix device.
- Agent tokens and bridge credentials live in the bridge databases. Message bodies and tokens are never logged.

### Live local conversations (GET-485)

Contact `configuration` is `{modelMode:"follow"|"fixed",provider?,model?,thinking:"follow"|supportedLevel}`; fixed models require provider and model. Only documented scalar fields are accepted. `icon` is one of `auto|spark|code|research|write|compass|brain|person`. Public contacts expose `profile`, the resolved next-message `execution`, or `configurationError` with `configuration_required`. Discovery rereads saved defaults; explicit refresh also refreshes the available catalog. Pi terminal-only model changes must be saved as startup defaults or selected independently on the contact.

Accepted local contact and scratch runs freeze `executionSnapshot:{agentId,provider,model,thinking,modelPolicy,thinkingPolicy,configurationVersion}`; retry preserves it. Updating settings affects subsequent acceptance, never a queued invocation. Existing legacy runs without a snapshot retain compatibility behavior. No model/provider fallback is added. Pi compares the final response model/provider against the requested selection.

`run.progress:{phase,text,updatedAt}` contains credential-redacted visible answer text and a coarse phase in direct conversations, throttled to at most ten writes per second. Groups expose phases until final audience/provenance checks pass. It contains no private reasoning or tool parameters. SSE/IPC invalidation asks clients to reload facts. Partial text is not an artifact; only a successful final protocol result and settled process create a completed document. Cancellation/failure preserve unfinished text and precise run state. Causal context includes completed predecessor replies arriving after the follow-up was accepted, while still excluding future questions, post-join hidden content and other recipients.

### Local agent onboarding

| Method | Contract |
| --- | --- |
| `GET /api/agent-onboarding/context` | Bounded projection of role/group cards, recent group-owner messages and explicit memories; excludes DMs, credentials and other projects |
| `GET /api/agent-onboarding` | Latest 20 durable preparation jobs |
| `POST /api/agent-onboarding` | `{clientId,agentId,configuration?,goal?,includeRecentMessages?,includeMemories?}`; 202 queues an immutable context/model snapshot in the existing worker |
| `GET /api/agent-onboarding/:id` | Progress, probe result, accepted model, source references, inferred habits and role suggestions |
| `POST /api/agent-onboarding/:id/adopt` | `{clientId,suggestionId}`; creates exactly one contact per suggestion, pinned to the tested model. Does not add group membership |
| `POST /api/agent-onboarding/:id/cancel` | `{clientId}`; cancels this preparation only |

Preparation performs an actual random-challenge model probe before analysis, with no provider fallback. States: queued, probing, analyzing, completed, failed, cancelled, interrupted. Installation/auth detection is not probe evidence. Source text is untrusted; habit inferences require supplied message/memory sources. Roles cite supplied sources and optional existing groups. Analysis never writes contacts; explicit adoption is transactional and idempotent. Sources are capped at 48,000 characters plus bounded handles and metadata, with at most 30 role cards, 20 groups, 5 owner-message snippets of 600 characters per group and 20 memories of 600 characters. DMs/attachments are excluded. Hidden `purpose:agent_onboarding` threads reuse the existing queue and do not appear in the ordinary chat list; interrupted preparation is preserved without automatically retrying the provider.

### Personal Agent goals and schedules

`GET /api/contacts/:id/control` returns the per-contact goal, version, schedule, truthful capability flags, next run, state, today's admitted/reserved run count and ten recent goal runs. Defaults are paused/empty goal and scheduling **off**, interval 60 minutes, daily 09:00 `Asia/Shanghai`, maximum four runs per local day. `POST` to the same route accepts `{clientId,version,goal:{text,status},scheduler:{enabled,mode,intervalMinutes,time,timeZone,maxRunsPerDay}}`. Goal status is `active|paused|completed`; schedule mode is `interval|daily|autonomous`. Intervals are 15–10080 minutes (autonomous 15–1440); daily time is HH:mm with an IANA timezone; maximum runs is an integer 1–24. Enabling requires an active nonempty goal and available backend. A stale version is 409; accepted requests have durable idempotent receipts.

`POST /api/contacts/:id/run` accepts `{clientId,version}` and returns 202 `{control,threadId,runId}`. It runs the saved active goal once even when scheduling is off, within the same daily budget and unresolved-work barriers. Goal runs are system-triggered messages in that contact's existing direct chat; they do not impersonate a new owner message, broadcast to groups or read other chats. Goal/persona/model/transport inputs are immutable snapshots. Current goals also appear only in the intended Agent's own accepted persona, never other participants' persona summaries.

One app-owned scheduler feeds the bounded worker registry and its conversation/session lanes. Owner messages take priority over waiting goal ticks. Each contact has at most one active goal run, missed slots coalesce and restart does not replay accepted submissions. A queued run reserves the day on which it actually starts, so a midnight wait cannot bypass the daily budget. Daily times skip nonexistent DST times and never use both repetitions of the same local time. Exit/sleep does not run an OS daemon. Pause/version changes invalidate unsent queued ticks; already submitted work remains visible. Unknown/failed/cancelled/malformed results stop automatic continuation. Receipt-bound read-only reconciliation remains available after pause; it never resubmits the message. Retry new goal work through current controls, not the historical run retry endpoint.

Only executable local Codex/Claude/Pi adapters support structured autonomous continuation. Their response must be exactly `{reply,goalStatus:"continue"|"completed"|"needs_input",nextRunMinutes,reason}`; continued delays are integer 15–1440 and other states require null. The renderer receives the validated visible reply; raw scheduling JSON is not streamed. A model cannot enable schedules, change a backend or increase limits. A2A contacts support fixed interval/daily messages using the saved connection identity; MCP tool calls and human contacts do not support goal scheduling.

`GET /api/host/discovery` projects coarse host facts, sampled installed/configured local adapters, safe existing-contact summaries (`readyContacts` separately from unverified `configuredContacts`) and 1–3 recommendations. It neither invokes a model nor installs or changes CLI configuration. Unknown memory pressure/disk/queue metrics remain unknown. Existing connected services open the existing contact; remote conversation isolation is not inferred. New roles reuse the established onboarding preview/adoption path. Raw MCP tools are excluded from chat recommendations. MCP contacts preserve their ID/history but require explicit `chatBackend:{type:"local",localAgentId}` for new messages; model options apply to that chosen planner, and actual MCP calls still require exact approval. Historical accepted runs retain their prior snapshots.

## Personal native approval inbox

The main-owned per-instance A2A endpoint supports authenticated `agentstudio/approvals/list` → `{approvals:[{id,revision,requestGeneration?,title,choices:[{key,label}],state,replyTo?,choiceLabel?,source?,originalAppOnly?,deliveryState?,responseRequestId?}]}` and `agentstudio/approvals/respond` with `{id,revision,choice,requestId}` → `{state:"accepted"|"unknown"|"stale"|"sending"}`. These operations are not arbitrary renderer HTTP routes. Native sources are registered through owner-bound main/utility IPC only. Card absence is not resolution; conflicting request ID payloads and changed cards are rejected. `requestGeneration` stays stable through observation/status changes; a new semantic generation cannot inherit an earlier answer receipt. A response may reach the provider even if its receipt is unknown, so it is never replayed automatically. Both main and utility reject responses to `originalAppOnly`, even when options are supplied.

`POST /api/decisions/:id` retains `{version,choice,clientId}`. For `kind:"provider_approval"`, choice must equal an opaque key on the current card; the same durable decision endpoint queues a single exact response. It does not reuse the outbound-send approve/reject meaning. Provider decisions expose `choiceLabel` and `providerSource:"original"|"agentroom"`; native permissions have no local response choices. `GET /api/approvals` includes independent cards with no run. Workspace switching and connection deletion also account for these pending/sending/unknown decisions.

The same Decisions module projects `/api/approvals` and thread decisions with `requestType`, `authority`, `capabilities` and separate `facts:{interaction,response,execution,verification,verificationScope,localArtifactVerification}`. Accepted provider answers always report execution `not_observed` and verification `not_provided`. A failed explicit readback stays failed even when its local evidence artifact was checksum-verified. A different actor cannot gain owner authority by adding fields to a request body.

For supported MCP requests only, `{choice:"approve",grantDuration:"conversation_exact",version,clientId}` explicitly creates an exact-operation grant in this conversation (one hour, at most ten operations including the first). The full tool arguments, optional listed readback, tool declarations, connection/account/session, contact and accepted audience must match. Each operation retains a distinct run/operation ID. Default or `grantDuration:"once"` authorizes one operation. Provider choices never create local grants. Views include `authorization:{kind,state,grantId,expiresAt,remaining,maxUses,scope}`. `{action:"revoke",version,clientId}` on an associated decision revokes future use; an operation already claimed may have reached the service. A durable transaction reserves usage and records Attempt before dispatch; unknown attempts are not replayed after restart.

Grok `waiting` native progress may include `link:{label,url}` and `expiresAt` for the original PKCE start page only. Its `open-login` choice reuses the same in-memory flow; `copy-login` copies main's stored URL only while that flow is active and within its deadline. Neither action accepts a URL or clipboard text from the renderer. The URL carries public challenge/uuid parameters; verifier, access/refresh tokens and intermediate authentication callbacks are excluded. The client wait deadline is separate from provider session expiry. Expired progress explicitly asks for a new connection; copied old links cannot authorize a replacement flow.

## Personal remote server nodes

`POST /api/nodes/connect` accepts `{url, token, clientId?}`. The URL must be a Tailscale `.ts.net` HTTPS origin, literal Tailscale IPv4 HTTP origin, or loopback HTTP for isolated tests. It authenticates the node manifest, validates all agent endpoints are same-origin, and atomically creates A2A connections. The response contains `{node, connections}` without credentials. Repeated enrollment reuses stable connections; changed node identity or credentials cannot replace old authority. `POST /api/nodes/{nodeId}/check` accepts `{}` and updates timestamped availability. `GET /api/integrations` includes `nodes`. Individual agents use the existing guarded connection deletion. See [setup, task lifecycle and token revocation](personal/remote-nodes.md). These fixed routes are also available through desktop IPC.


## Personal desktop device sharing

`GET /api/sharing` returns `{enabled,name,host,addresses,url,state,error,contacts,requests}` without credentials. `POST /api/sharing` accepts `{enabled:false}` or `{enabled:true,name,host,contactIds}`. Sharing defaults off and binds only an actual local Tailscale IPv4 address. Selected owned Agent contacts appear in an authenticated `agentroom-node/1` manifest with `kind:desktop`, opaque contact IDs and same-origin `/agents/{id}` endpoints. Only local CLI bindings support `message/send`; remote bindings are not re-exported. `tasks/get` is scoped to the original sharing generation and contact; messageId is the durable taskId. Request and independent execution records commit atomically. No remote route exposes threads, credentials or arbitrary desktop APIs. Workspace switching freezes acceptance before checking idleness.

Explicit local `POST /api/sharing/invite` with `{}` returns `{url,token}` for intentional transfer. Like the separate guest-room invitation reveal, this is protected by the loopback Host/Origin boundary and fixed native IPC. Native `copyDeviceInvitation()` obtains the current invitation in main and copies it without arbitrary clipboard reads or writes. Stop/start retains identity and authority so accepted tasks can recover. Initial enrollment rejects an empty directory until the source selects a contact.

`Contact.presence` projects `{state,deviceName,lastSeenAt,checkedAt,reason,running,waiting}` independently of configuration availability. `GET /api/integrations` includes node presence and the last directory. Node checks coalesce, run every 15 seconds, retain success timestamps on failure, expire after 60 seconds, and cannot resurrect removed credentials. New contacts can be discovered; deliberately removed contacts remain suppressed. See [device setup and boundaries](personal/peer-devices.md).


### Native service recovery state

The desktop owner privately projects native instance readiness and durable receipt metadata to its utility. Contacts may retain `avatarService` and a bounded `avatarDataUrl` while disconnected; readiness is observed independently of a saved connection. Catalog instances include `hasCredentials: false` when the original login record is missing. This adds no HTTP or preload mutation route. Prior-generation dispatch failures can become `failed/not_sent` only with matching owner/frozen identity evidence and an intact ledger without the stable message ID; current-process timeouts remain unknown and are never replayed. See [native service recovery](personal/native-service-recovery.md).


## Personal conversation unread state

`GET /api/bootstrap` thread summaries and `GET /api/threads/:id` include `unreadCount`. It counts persisted assistant messages after the workspace's read cursor; owner messages, system events, stream progress, reactions and approvals do not increment it. Fetching a thread does not mark it read.

`POST /api/threads/:id/read` accepts `{messageId}` for an assistant message in that conversation and returns `{unreadCount}`. It is naturally idempotent and monotonic without `clientId`: acknowledging a rendered older snapshot cannot read a later response or move the cursor backwards. It persists a separate `thread_read` document without changing the transcript, version or activity time, and invalidates snapshots only when advancing. Unknown/non-incoming message IDs return 400; unknown threads return 404. The fixed personal IPC allows this route.

First upgrade baselines existing transcripts as read once; subsequent incoming messages and read cursors survive utility restarts. The renderer acknowledges only a visible, focused conversation at the latest messages with no covering modal. These are local owner read states, not receipts sent to external agents.

### Personal Agent avatar descriptor

Agent contacts accept optional `avatar`: null selects original provider presentation; otherwise `{ version: 1, style: "bottts", seed, palette, eyes, mouth, top, motion }`. Seed is 1–128 characters. Palette: blue/violet/orange/teal/rose. Eyes: round/happy/eva/robocop. Mouth: smile01/smile02/grill01/diagram. Top: antenna/radar/pyramid/glowingBulb01. Motion is boolean (defaults true). Unknown fields, invalid values and non-Agent descriptors are rejected. Existing contact version/idempotency checks apply; omission preserves the descriptor. Creation supplies a deterministic default. Accepted run identities snapshot the config; discovery does not replace it.

Read-only `avatarActivity` contains state plus optional runId/completedAt, derived from actual contact runs and pending decisions. Uncertain stops precede input, active work, queues and the latest terminal outcome. An online remote device may supply aggregate running/waiting counts. No model can set runtime activity through an avatar descriptor. Rendering is local using pinned DiceBear 9.4.2; no avatar request or CSP expansion is required.


### CC Switch configuration inventory

Integrations and refresh include `ccSwitch`: `{status:"available"|"not_found"|"unavailable",clients,profiles:number|null}`. Fixed Codex/Claude/Pi/Gemini/OpenCode clients contain `{id,name,providers:{total,selected}|null,mcp,skills,prompts:number|null}`. MCP/Skills are `{enabled,names,truncated}|null` with at most 50 names of 100 characters. Null means an unrecognized schema, including missing per-client enable columns. Counts describe saved configuration, not installed CLI support, extension health or execution grants.

Only the fixed server home `.cc-switch/cc-switch.db` is read, using a read-only connection, short lock wait and one snapshot transaction. Missing databases are not created. Invalid or oversized files return unavailable without breaking CLI discovery. No config, credential, prompt-body, endpoint, payload or log columns are selected. Existing refresh rereads metadata. Synthetic CLI discovery defaults to an absent inventory unless an isolated home or inventory reader is explicitly supplied. These names never automatically become model context or contacts.

## Restored group and Roo setup contracts (GET-547)

The [migration ledger](migrations/agentstudio-merged-features.md) records all 52 merged old PRs and the seven divergent merges. `GET /api/roomie` and `POST /api/roomie/{messages,actions,links}` retain compatibility names for Roo's setup panel; `roomie_job`/historical Roomie records are preserved. Native directory selection uses `chooseProject()`; renderer IPC cannot submit an arbitrary project path. The authenticated browser owner API may submit `POST /api/roomie/projects`. A verified job proposes roles/groups; `add_role`, `create_group` and `apply_project` are explicit owner actions. No model completion automatically creates a group or changes an existing Roo binding. Monitoring only samples supported configuration metadata.

Local discovery also gives existing unbound Roo/Roomie companions their first eligible local chat backend, including completed-onboarding profiles. Selection uses the saved local default, then Codex, Claude Code and Pi, validating the companion's effective configuration. Existing bindings remain authoritative. Historical `agentroom_roomie` identities become `systemRole: "guide"`; their original direct thread accepts the normal `POST /api/threads/:id/messages` route and retains its messages/runs. This transactional upgrade does not create a model run or reset onboarding.

`GET/POST /api/chats/:id/sharing` handles owner review of public background and Agent personas, invitation publication/closure and roster removal. Guest pages and `/g-api` use a separate listener and scoped invitation/session tokens; they have no owner API authority. Compatibility `/api/playrooms` routes preserve old invitations and migrate historical rooms into ordinary group threads. `GET/POST /api/chats/:id/artifacts` exposes fixed-path shared notes, polls and quizzes. Guests never receive private history, memory, attachments, project grants or MCP tools. Codex/Pi public execution must retain isolated user context and cannot fall back to ordinary execution.

`group_create`/`group_add_agents` create modern ChatTools approval requests. `group_invite` always prepares a draft for owner review; legacy `auto_new_group` rules are read as `review`. `project_list`/`project_read` are available only for an accepted project grant bound to audience, local binding and authentication fingerprint. Reads reject hidden files, credentials, symlinks and files over 100KB. Project and group artifact dependencies propagate through all derived outputs and pending MCP requests. Publication changes invalidate pending private chat/MCP actions even if the room version did not change.

## Local assistant catalog and lifecycle (GET-552)

`GET /api/assistants` returns `{checkedAt,source:{status,checkedAt,error?,refreshing?},entries,operations}`. Entries distinguish native tool versions from ACP adapter versions and include installed/latest versions, source, optional path/repository and explicit unsupported reasons. Background metadata refresh never installs or calls a model. `POST /api/assistants/refresh` accepts only `{}`. `POST /api/assistants/install` accepts only `{agentId,action:"install"|"update",expectedVersion,clientId}` and returns an asynchronous operation with HTTP 202. A changed catalog version conflicts before installation; replay keeps its accepted version/job. Installation state also participates in workspace-switch blockers. These routes are fixed personal-desktop IPC routes. See [assistant management](personal/assistant-management.md).

Installed ACP executors join `/api/integrations` and the existing explicit `/api/contacts/local` flow. Their authentication remains unknown until the agent's own authentication/execution confirms it; metadata/handshake is not account verification. Accepted runs persist server-owned executable coordinates, so managed updates affect new runs without rewriting accepted requests. Existing tool authority is unchanged.
