# Clients: screens, behaviour and test ids

## First conversation: 阿屋 Roo (GET-518)

New workspaces open one persistent guide DM, identified by the product mascot. Configuration detection is distinct from successful execution. Existing profiles keep their normal entry; Settings → 测试与引导 deliberately reopens the guide without clearing data. The inline guide uses existing contact/discovery/connection/role flows and approvals.

| Surface | `data-testid` |
| --- | --- |
| Guide / backend | `workspace-guide`, `workspace-guide-backend` |
| Environment / local contacts | `workspace-guide-discover`, `workspace-guide-local` |
| Connections/device requests / roles | `workspace-guide-connect`, `workspace-guide-roles` |
| Owner name / finish / saved | `workspace-owner-name`, `workspace-guide-finish`, `workspace-guide-completed` |

`node dev/agentroom-acceptance.mjs` and `--native` check guide entry/actions and profile isolation. The old welcome remains a fallback for bootstrap fixtures without a guide.

Personal device sharing lives under Settings → Connections. `device-sharing`, `device-sharing-form`, `device-sharing-name`, `device-sharing-address`, `device-share-{contactId}`, `device-sharing-save`, `device-sharing-disable`, `device-sharing-state`, `device-sharing-reveal`, `device-sharing-url`, `device-sharing-token`, `device-sharing-copy`, and `device-sharing-open-request` cover the opt-in host flow. The existing `personal-node-*` enrollment IDs remain compatible; `personal-node-paste` and `personal-node-invitation` accept an explicitly pasted invitation without clipboard-read permission. Avatar `im-presence-dot` has `data-state=online|reconnecting|offline|attention|unknown`; list, detail and `im-header-status` include text and device provenance. Last online time appears in contact details when disconnected. Full setup and readiness limits: [devices](personal/peer-devices.md).

Personal automatic Bot avatars use `im-avatar` with `data-avatar-source="bot"`; the image uses `im-avatar-image`. An explicit persona icon takes precedence. Native service images arrive as bounded PNG data URLs, with the service brand as fallback.

## AgentRoom first-use and test mode

The empty chats home offers onboarding without blocking sidebar navigation or legacy links. Settings adds a 测试与引导 tab. Test profiles show a persistent mode label. Test-only reset rotates to a fresh profile; the normal workspace never has that reset button.

| Element | `data-testid` |
| --- | --- |
| Welcome / owner name | `workspace-welcome`, `workspace-owner-name` |
| Start / role setup / connect | `im-welcome-start`, `workspace-welcome-agents`, `workspace-welcome-connect` |
| Preferences / reopen | `personal-tab-testing`, `workspace-tools`, `workspace-reopen-welcome` |
| Enter / reset / return | `workspace-enter-test`, `workspace-reset-test`, `workspace-leave-test` |
| Persistent mode | `workspace-mode` (`data-test-mode`) |

`node dev/agentroom-acceptance.mjs` and `--native` cover welcome persistence, reopen, profile isolation and recovery using synthetic data. Details: [testing](personal/testing.md).

## Local quick add and Agent cards (GET-498)

All Add Contact entries and the welcome local-assistant action open the same local-first picker. Installed, supported assistants with detected login and valid model configuration come first; recent direct chats order otherwise equivalent candidates, then names provide a stable fallback. “最近聊过” is conversation evidence, not execution verification. Each row offers one action: adopt the stable contact and open chat, open an already adopted contact, or check login/configuration. Model errors open the existing contact editor; login goes to connection settings. Unsupported installed adapters are disclosed separately without a chat action. Opening chat sends no greeting and runs no model. Lost adoption receipts reuse the same clientId, failed chat opens preserve adoption, and refresh retains visible rows but disables stale actions until revalidated.

Custom roles and human contacts are secondary picker actions. The role editor places assistant binding before name/instructions; appearance and model/username/biography are disclosed on demand. Closing disclosures retains their values; invalid fields reopen their containing disclosure. Existing connections and backend identity are preserved.

| Surface | `data-testid` |
| --- | --- |
| Welcome / contacts entry | `workspace-welcome-local`, `im-local-add-entry` |
| Picker / fresh check / retry | `im-local-picker`, `im-local-refresh`, `im-local-retry` |
| Candidate / single row action | `im-local-candidate-<agentId>`, `im-local-action-<agentId>` |
| Unsupported disclosure / empty / connect | `im-local-other`, `im-local-empty`, `im-local-connect-empty`, `im-local-connect` |
| Secondary role / human entry | `im-local-customize`, `im-local-human` |
| Editor disclosures | `im-contact-appearance`, `im-contact-advanced` |
| Shared contact/profile card | `im-agent-card`, `im-agent-card-model`, `im-agent-card-quota`, `im-agent-card-capabilities` |

The card is shared by contact details and the chat-header profile. It describes next-message configuration and adapter capabilities, not a verified execution or cross-model intelligence score. Unknown quota is “暂不可获取”; common accounts may share quota. Multi-computer pairing and friend sharing are future phases, with no active controls in this release. Isolated synthetic acceptance: `node dev/local-agent-cards-acceptance.mjs` (or `--native`), output selected through `AGENTROOM_CARDS_EVIDENCE_DIR`.

## Personal conversation workspace

The Mac Electron app opens the personal workspace by default. Its renderer shares `apps/personal` UI, uses the dedicated `window.agentStudioPersonal` preload and fixed IPC, and leaves API HTTP to its owned utility. It does not read the old session or start legacy connectors. Personal data belongs to the Electron profile's `personal` directory; the auxiliary web build has separate `.local/personal` data. See [setup](personal/README.md) and [the IPC contract](api.md#default-personal-desktop-ipc).

The existing native window and traffic lights remain. Closing hides it while work continues; Dock activation reopens it, and quit closes its utility. Native menu commands are New (`⌘N`), Search (`⌘K`) and Settings (`⌘,`). macOS Messages informs navigation and reading comfort; AgentRoom has its own [visual language](personal/visual-language.md). A quiet sidebar frames rounded gray Agent reply bubbles in direct and group chats, including streaming replies, while deep slate-blue outgoing bubbles identify the owner's messages. Contact identity is aligned with the conversation toolbar. There is no top-left app logo. Narrow widths use a single list or chat with Back. Reload/deep links restore the selected chat. A save action opens the native dialog, then reports the saved artifact's byte hash.

| Messenger element | `data-testid` |
| --- | --- |
| App / navigation | `im-app`, `im-nav-chats`, `im-nav-contacts`, `im-nav-approvals` |
| New / settings / search / refresh | `im-new`, `im-settings`, `im-search`, `im-refresh` |
| Owner profile / list toolbar / integrated search | `im-profile`, `im-list-toolbar`, `im-search-group` |
| Native window drag strip | `im-window-drag` |
| Filter disclosure / options | `im-filter-toggle`, `im-filter-options` |
| List filters | `im-filter-all`, `im-filter-group`, `im-filter-agent`, `im-filter-human`, `im-filter-history` |
| Conversation filters | `im-filter-pinned`, `im-filter-attention` |
| Pinned shortcuts / pin toggle | `im-pinned`, `im-pinned-<threadId>`, `im-pin-<threadId>` |
| Pin context menu / toggle / reorder | `im-conversation-menu`, `im-menu-pin`, `im-pin-earlier`, `im-pin-later` |
| Chat / contact / approval rows | `im-chat-<id>`, `im-contact-<id>`, `im-approval-<id>` |
| Conversation message preview | `im-chat-preview` (scoped to `im-chat-<id>`) |
| New conversation / group / contact | `im-welcome-start`, `im-new-group`, `im-new-contact`, `im-start-<contactId>` |
| Contact profile / start / edit | `im-contact-detail`, `im-start-chat`, `im-edit-contact` |
| Full provider name / editor source / suggested name | `im-contact-source-name`, `im-contact-name-source`, `im-contact-name-suggestion` |
| Contact editor / fields | `im-contact-editor`, `im-contact-name`, `im-contact-handle`, `im-contact-description`, `im-contact-backend`, `im-contact-instructions`, `im-contact-save` |
| Detected profile / model / thinking | `im-agent-options`, `im-detected-model`, `im-profile-refresh`, `im-model-options-toggle`, `im-model-policy`, `im-model-select`, `im-model-provider`, `im-model-name`, `im-model-thinking` |
| Explicit Pi identity / avatar choices | `im-extract-identity`, `im-avatar-icon-<icon>` |
| Live reply slot / partial / precise stop | `im-response-<runId>`, `im-streaming-message`, `im-run-stop-<runId>` |
| Group editor / name / members / policy | `im-group-editor`, `im-group-name`, `im-group-search`, `im-member-<contactId>`, `im-policy-<contactId>`, `im-group-save` |
| Group portrait / picture / reset | `im-group-avatar-editor`, `im-group-avatar-preview`, `im-group-avatar-file`, `im-group-avatar-image`, `im-group-avatar-reset`, `im-group-avatar-error` |
| Group motif / color | `im-group-motif-<room\|spark\|code\|compass\|leaf\|coffee>`, `im-group-color-<teal\|blue\|violet\|orange\|rose>` |
| Conversation / contact information / create group | `im-main`, `im-chat-info`, `im-promote-group`, `im-back` |
| Messages / content / actions / running state | `im-timeline`, `im-message` (`data-contact-id`), `im-message-content`, `im-message-actions`, `im-reply-message`, `im-run-status` |
| Avatar / group sender profile | `im-avatar` (`data-avatar-source`), `im-message-avatar` |
| Composer / text / send / file / mentions | `im-composer`, `im-message-input`, `im-send`, `im-attach`, `im-mention-list`, `im-mention-<contactId>` |
| Draft attachment list / item / preview / remove (zero-based index) | `im-draft-files`, `im-draft-file`, `im-draft-preview-<index>`, `im-draft-remove-<index>` |
| Approvals / return | `im-pending-bar`, `im-approval-open-chat` |
| Approval source / contact / original chat | `im-approval-source`, `im-approval-contact`, `im-approval-source-chat` |
| Approval sender in each row and detail | `im-approval-sender-name` (scope to the row or source section) |
| Related request / expand and collapse | `im-approval-request-text`, `im-approval-request-toggle` |
| History / scratch / mode / recovery | `im-new-notes`, `im-send-options-toggle`, `im-task-mode`, `im-task-connection`, `im-send-recovery` |
| Results / records / artifacts | `im-results`, `im-conversation-details`, `im-artifact`, `im-execution-record` |
| Rail / list / skip | `im-rail`, `im-list-panel`, `im-skip` |
| List scroll surface | `im-list-scroll` (a fresh surface when switching sections) |
| Focus reading / reveal list | `im-focus-toggle` (`aria-expanded`, `aria-controls`) |

Every approval row names its sender with “由 … 发起”, followed by the request title, provider, contact handle, Bot ID and original direct/group/task conversation. Rows, detail headings and the toolbar use the same sender label. A provider's default `New Bot` name is displayed as the service plus the full stable Bot ID (or handle/connection ID when unavailable); details explain that the original service has not named it. Custom contact names stay intact. If the contact is missing, known provider attribution is still shown; an unidentifiable sender is explicitly marked for checking. Details put the contact portrait, address-book link, accepted name when renamed, provider/Bot identity, original conversation and the bound user request before the choices. Standalone provider cards explicitly say when no local message is linked. Search includes both names, handle, provider, Bot ID, conversation and request text. Display labels do not rename contacts or change the approval's decision/run/connection binding.

Every personal conversation uses this Messenger shell, including old `?workspace=tasks&thread=…` links and scratch drafts (`?thread=new`). The old workspace parameter is removed without replacing the shell. Historical threads retain their IDs, mode/connection and draft recovery keys; no message is sent during migration. The conversation title opens its contact/group information; the single `im-results` information button opens result versions and execution records. `im-new-notes` continues the old unsent scratch draft or starts local organization. Native New Chat opens the conversation picker.

Conversation-list message previews render Markdown emphasis, inline code and strikethrough on a single ellipsized line. Headings, lists, tables and code blocks are flattened into inline content with spaces; links show their label and images their alternative text, without adding interactive controls or fetching images inside the conversation button. Approval and running status still take precedence.

Completed replies display their Markdown content without a sender name, model, per-message time, delivery checkmark or original-artifact link. Direct replies have no repeated avatar; groups retain an avatar button with the sender's accessible name and hover title. Incomplete replies, local-only human delivery and actionable run states remain visible. Reply/copy tools appear on hover or keyboard focus; touch devices give them a separate row. Day separators and sidebar update times remain orientation aids. Normal connected status and composer keyboard hints are omitted. Focus mode hides the conversation list while keeping the navigation rail available; its toolbar button and shortcuts reveal the list before changing screens. The message timeline uses a slim, rounded scrollbar with a transparent track (6 CSS pixels in Electron), a muted thumb that becomes clearer on hover or keyboard focus, and stronger visibility in increased-contrast or forced-color modes.

The left rail contains the owner's profile, chats, contacts and approvals, with refresh and settings at the bottom. The owner opens the existing settings dialog. Selection uses icon color and a soft rounded surface, with no leading bar. The native personal window reserves a 42px drag strip above the three panes for its system traffic lights; all panes start below it, including focus and narrow detail views. The list has no redundant screen heading. Its top row combines a search input, a separate filter disclosure inside the same field surface, and an adjacent plus button. Search and filtering compose without opening each other; opening a conversation preserves the current chat query and filter. Contacts and approvals have their own filter choices, reset when switching screens.

Pinned conversations appear as circular portrait shortcuts with truncated names above the normal rows. Pinning is available beside each row and in its right-click menu. Pinned portraits also open that menu (`Shift+F10` from the keyboard), which supports unpinning and moving one place earlier or later. `Alt+Left/Right` reorders a focused portrait. The normal list keeps its original recency order; pinned shortcuts retain the saved explicit order, and both obey the current search and filter. Pinned preferences are local to this browser/Electron profile (`agentstudio.messenger.pins`), survive reload, and synchronize between windows of the same profile. They do not change server data or synchronize to another profile. Invalid saved preferences are ignored; unavailable thread IDs are retained but not displayed. A failed local save is reported in the list.

Automatic avatars use bundled official images for Codex/ChatGPT, Claude, Pi, Gemini CLI and OpenCode. Agent identities use rounded square portraits; human contacts remain circular. Native personal-service identities use the existing catalog's exact connection ID to select Grok Bot, Muse, Dots or Cue images; display names are never used to guess a provider. Explicit custom icons and colors remain user-owned. Human contacts without a portrait use name initials. Role agents without an explicit portrait use deterministic local Bottts robots; agents never fall back to name initials. Assets load locally without external avatar requests or changes to the renderer CSP. Brand provenance lives in `packages/brand/README.md`. These are product marks, not a claim that a provider verified a persona or supplied a live per-agent portrait.

Groups have an illustrated green room of overlapping conversation cards by default. Group information offers six motifs, five colors, a local PNG/JPEG/WebP picture picker (≤5 MiB) and Restore Default. The picture is center-cropped locally, normalized to a bounded PNG and previewed before Save; Cancel discards the draft. List rows, pinned portraits, headers and empty conversations use the same saved descriptor after reload. Invalid files retain the prior draft; a newer selection/reset wins over a late image read. Saved group images have no external URL or source metadata, and are never included in model context. `im-avatar` retains `data-avatar-source="group"`; `data-group-avatar-kind`, `data-group-icon` and `data-group-color` identify the displayed group treatment.

Above 760 CSS pixels, the sidebar button or `⌘\` (`Ctrl+\` off Mac) hides the list for focused reading. The preference survives reload. Search (`⌘K`) and rail navigation reveal it again; collapsing from inside the list moves keyboard focus to its toggle. Dialogs keep these shortcuts inactive. At 760 CSS pixels and below, the normal list/chat Back flow takes precedence, so a saved focus preference never removes navigation. Navigation uses neutral materials; the macOS personal window uses native sidebar vibrancy that follows window activity, while the reading pane stays opaque. Reduced transparency uses solid surfaces, reduced motion disables transitions, and increased contrast strengthens text and selection. See the [design reference and implementation order](personal/macos-design.md).

The shared reader, connection preferences and decision cards retain these IDs:

| Element | `data-testid` |
|---|---|
| Decision / approve / reject | `personal-decision`, `personal-decision-approve`, `personal-decision-reject` |
| Inline decision (same `data-decision-id` as inbox) | `im-inline-decision` |
| Exact conversation authorization / status / revoke | `personal-decision-approve-conversation`, `personal-decision-grant`, `personal-decision-revoke` |
| Original application instruction / real native opener when available | `personal-decision-original`, `personal-decision-open-original` |
| Reader / save / font / save receipt | `personal-reader`, `personal-reader-download`, `personal-reader-font`, `personal-save-receipt` |
| Modal / close / tabs | `personal-modal`, `personal-modal-close`, `personal-tab-connections`, `personal-tab-memory`, `personal-tab-about` |
| Preferences content / connection jumps | `personal-preference-panel`, `personal-jump-mac`, `personal-jump-agents`, `personal-jump-servers`, `personal-jump-tools`, `personal-connections-heading-tools` |
| Native service groups / management | `personal-service-instances-<service>`, `personal-service-instances-toggle-<service>` (more than two instances), `personal-service-remove-<instanceId>` |
| Connection / fields / save | `personal-add-connection`, `personal-connection-name`, `personal-connection-type`, `personal-connection-url`, `personal-connection-save` |
| Optional Bearer disclosure / password field | `personal-connection-auth-toggle`, `personal-connection-token` |
| Memory / save | `personal-memory-input`, `personal-memory-save` |

`node dev/messenger-acceptance.mjs` tests contacts and direct/group replies, including remote chat without per-message approvals. `node dev/conversation-acceptance.mjs` tests legacy links, exact pending-request migration, creation-response races and historical tools. Both accept `--native` after desktop build, use isolated profiles and synthetic data; the history fixture uses the existing mock keychain switch only for its fresh test profile. `node dev/personal-connect-synthetic.mjs --synthetic` also exercises two direct Muse chat turns through the real native connector against the existing fake service, while retaining an explicit Cue task approval. The complete reading/connection/browser edge checks use the same Messenger IDs.

## Retained Matrix clients

`AGENTSTUDIO_WORKSPACE=matrix` selects the original desktop renderer and `window.agentStudioDesktop` preload. The IDs and contracts below remain unchanged. In this mode, desktop (Electron) and mobile (Expo) implement the same flows on top of `@agentstudio/core`. E2e tests select elements only by `data-testid`. On React Native the same strings go in `testID`, which react-native-web renders as `data-testid`. The `data-*` attributes below (`data-room-name`, `data-sender`, `data-own`, `data-step-type`, `data-network`, `data-state`) go in react-native-web's `dataSet` prop, so the mobile web build renders the same attributes as desktop (native ignores `dataSet`). The ids below are a contract: do not rename them. Run the cross-client stack suite with `AGENTSTUDIO_WORKSPACE=matrix pnpm test:e2e`; isolated desktop smoke also explicitly selects Matrix mode.

## Startup and configuration

- Server URL comes from these sources, in order:
  - desktop: env `AGENTSTUDIO_SERVER_URL`, then the saved setting, then the default `http://127.0.0.1:18090`
  - mobile: `EXPO_PUBLIC_AGENTSTUDIO_SERVER_URL`, then the same default
- The session (refresh token, matrix credentials) is persisted:
  - desktop: in the Electron `safeStorage`-encrypted file, accessed through preload
  - mobile native: `expo-secure-store`
  - mobile web: `localStorage`
- E2e uses a fresh profile directory or storage each run. Set `AGENTSTUDIO_USER_DATA_DIR` on desktop.

## Screens

### Sign in

| Element | `data-testid` |
|---|---|
| Email input | `signin-email` |
| "Send code" button | `signin-send` |
| Code input | `signin-code` |
| "Sign in" button | `signin-verify` |
| Error text | `signin-error` |

On success the app opens the inbox.

### App shell

| Element | `data-testid` |
|---|---|
| Inbox nav | `nav-inbox` |
| Approvals nav | `nav-approvals` (shows pending count badge `nav-approvals-badge`) |
| Tasks nav | `nav-tasks` |
| Connect nav | `nav-connect` |
| Settings nav | `nav-settings` |

On mobile, these are bottom tabs with the same ids. The chat is a stack screen inside the Inbox tab, so the tab bar stays visible in a chat; leaving the Inbox tab returns it to the chat list, and opening a chat from a chat replaces it (at most one chat is mounted).

### Inbox

| Element | `data-testid` |
|---|---|
| Filter tabs | `inbox-filter-all`, `inbox-filter-agents`; mobile also has `inbox-filter-people` (the Mac app has no People filter for now) |
| List | `chat-list` |
| One row per room | `chat-row` with attribute `data-room-name="<name>"`. On RN the row also has `accessibilityLabel` = the name and a nested `chat-row-name` element with the name. |
| Unread badge in a row | `chat-row-unread` |
| Network label in a row | `chat-row-network` (e.g. "Demo", "Agent") |
| Empty state | `inbox-empty` with a "Connect an account" button `inbox-connect` |

- Rows are sorted by last activity.
- Agent rows show the agent status text (`chat-row-status`) and a "Needs you" marker (`chat-row-needs-you`) when the agent has pending approvals.

### Chat (room view)

| Element | `data-testid` |
|---|---|
| Header with name | `chat-title` (inside `chat-identity`, which also holds the avatar) |
| Connect step that asks for a value (the Cue API key) | `local-login-input`, `local-login-submit`, `local-login-input-error`, `local-login-link` |
| Connect screen: a service's card / its agents button / summary | `local-service-card-{id}`, `local-service-manage-{id}`, `local-service-summary-{id}` |
| A service's agents sheet (rows, close, check for new agents) | `local-sheet`, `local-connector-row`, `local-sheet-close`, `local-sheet-add` |
| Extra button while a connect step waits (e.g. "Use an API key instead") | `local-login-action-{id}` |
| "Waiting on you" row above the list (desktop, All only; agents with a pending approval or at work) | `agent-waiting`, `agent-waiting-item`, `agent-waiting-more` |
| Agents needing attention: banner, its button; a row's status ("Sign in again") | `agent-trouble`, `agent-trouble-fix`, `chat-row-status` |
| One-time note about agents on this Mac | `local-mode-note`, `local-mode-note-ok` |
| Message parts: an image / a file an agent sent; "In Grok Bot" under what the user wrote in the service's app | `message-image`, `message-file`, `message-via` |
| Settings: export diagnostics | `settings-export-diagnostics` |
| Delete a chat (desktop) | `chat-menu` → `chat-delete` → `chat-delete-confirm` (leaves and forgets the room) |
| Notifications from an agent (desktop, agent chats) | `chat-menu` → `chat-notify-all`, `chat-notify-approvals`, `chat-notify-mute` (`role="menuitemradio"`, the current one has `aria-checked="true"`) |
| A real picture in an avatar (person's or agent's own) | `avatar-image` |
| A person's initials, when they have no picture (agents never show initials) | `avatar-initials` |
| Network label | `chat-network` |
| Timeline | `timeline` |
| Each message | `message` with attributes `data-sender` (display name) and `data-own="true\|false"`. On RN, testID `message`. |
| Message body | `message-body` |
| Composer input | `composer-input` |
| Send button | `composer-send` |
| Failed send | `message-failed` |
| Back to the chat list (mobile only) | `chat-back` |

Opening a message's actions (hover menu on desktop, long-press on mobile) shows "Ask an agent" `message-ask`. The mobile web build also shows a small always-visible `message-ask` button beside each askable message, since long-press is awkward with a mouse.

**Approval card** (rendered for a `com.agentstudio.approval` message):

| Element | `data-testid` |
|---|---|
| Card | `approval-card` |
| Title | `approval-title` |
| Details rows | `approval-detail` |
| Choice buttons | `approval-choice-<key>`, e.g. `approval-choice-book` |
| State after decision | `approval-state`, text "Approved: Book" / "Declined: Don't book" / "Expired" |
| Countdown | `approval-expiry`, e.g. "44 min left" |

**Drafts card** (for `com.agentstudio.drafts`):

| Element | `data-testid` |
|---|---|
| Card | `drafts-card` |
| Each draft | `draft-item` |
| "Use" button per draft | `draft-use` |

"Use" opens the origin chat with the draft text placed in its composer, editable and not auto-sent. When the user sends it, the client calls `POST /v1/tasks/{id}/sent`.

### Ask an agent (modal or sheet)

| Element | `data-testid` |
|---|---|
| Agent picker | `ask-agent-<agent name>`, e.g. `ask-agent-Concierge` |
| Request input | `ask-request` (default "Draft a reply") |
| Context preview: up to 5 lines (anchor + 4 prior) with checkboxes | `ask-line` + checkbox `ask-line-toggle` |
| "Don't ask again for this agent" | `ask-dont-ask` |
| Send | `ask-send` |
| Cancel | `ask-cancel` |

- The preview is skipped when the agent's consent says `ask_without_preview`.
- Lines from senders known only by a phone number or email are shown already anonymized (`Person 1`).
- After sending, the app navigates to the agent's chat.

### Approvals screen

| Element | `data-testid` |
|---|---|
| List of pending approvals | `approvals-list` |
| Each approval | an `approval-card` (same component as in chat) |
| Empty state | `approvals-empty` |

### Tasks screen

| Element | `data-testid` |
|---|---|
| Board | `tasks-board` |
| Columns | `tasks-col-pending`, `tasks-col-answered`, `tasks-col-done` |
| Each task | `task-card` with `data-state` |

### Connect

| Element | `data-testid` |
|---|---|
| Network section heading (desktop) / network card (mobile) | `network-<id>`, e.g. `network-demo`, `network-agentstudio-agents` |
| Flow "Connect" button | `flow-<id>`, e.g. `flow-concierge`, `flow-endpoint`, `flow-demo`. On desktop the login runs in a sheet that closes itself 1.5 s after `login-complete`. |
| Login step renderer | `login-step` with attribute `data-step-type` |
| `user_input` fields | `login-field-<id>` |
| Submit | `login-submit` |
| QR / code display | `login-qr`, `login-code` |
| Complete message | `login-complete` |
| Connected accounts list | `connection-row` with `data-network` and `data-state`, plus a remove button `connection-remove` |

### Settings

| Element | `data-testid` |
|---|---|
| Account email | `settings-email` |
| Server URL | `settings-server` |
| Sign out | `settings-signout` |
| Version | `settings-version` |
| System notifications switch (desktop) | `settings-notifications` (a checkbox) |
| Notifications per agent (desktop) | `settings-agent-notify`, one `<select>` per agent with `data-agent-name="<agent name>"` and the values `all`, `approvals`, `mute` |

## Behaviour rules

- **Auto-join:** the client auto-joins invites from bridge bots and ghosts on its own homeserver (see `matrix-events.md`).
- **Hidden rooms:** management rooms with a bridge bot are hidden.
- **Pending approvals:** the badge refreshes when a `com.agentstudio.approval` event arrives, and every 15 s while the app is visible.
- **Sending:** sends are optimistic. On failure the message shows `message-failed` with a retry.
- **Ask anonymization:** handled in `@agentstudio/core` (`buildAskQuote`), so both apps behave the same.

## Notifications and the Dock badge (desktop only)

`@agentstudio/core` decides what to notify (`NotificationCenter` in `notifications.ts`); the renderer hands each notification to the main process through the preload (`agentStudioDesktop.notifications`), which shows it and keeps the settings in `settings.json`.

- **What:**
  - a new approval: the approval's title, with the agent's name as the body; it opens Approvals
  - an agent's reply: the agent's name and the start of the message; it opens the chat
  - an agent that needs a new sign-in or has an error (its connector on this Mac, or an agent reported offline): it opens Connect
  - a message from a person: the chat's name and the message; it opens the chat
- **Priority:** approvals make a sound and stay where the platform allows it. Agent replies and problems are normal notifications. People's messages are silent, and a newer one replaces the older one from the same chat.
- **When not:**
  - nothing from the first sync, and nothing older than 2 minutes when it arrives, by the event's own timestamp (bridge backfill, imported history, catch-up after sleep)
  - edits (`m.replace`)
  - nothing about the chat (or, for approvals, the Approvals screen) the user is looking at in a focused window
  - own messages and bridge bot notices
- **Settings:** a master switch (`settings-notifications`, on by default) and a mode per agent: all notifications, approvals only, or mute (`settings-agent-notify`, or `chat-notify-*` in the chat menu). They are saved by the main process and survive a restart. macOS asks for permission with the first notification; if nothing was shown yet, turning the switch on or the first badge count shows one "Notifications are on" notification so it asks (the Dock badge needs the permission too).
- **Dock badge:** pending approvals plus unread messages in agent chats, the same numbers as `nav-approvals-badge` and the agent rows' `chat-row-unread`. At 0 the badge goes away.
- **Background:** on macOS, closing the window hides it, so the app keeps syncing and notifying until the user quits.
- **Tests:** with `AGENTSTUDIO_TEST_NOTIFICATIONS=1` the main process records notifications and the badge in `globalThis.__agentStudioNotifications` (`{ shown, badge, click(i) }`) instead of showing them; e2e reads them with `electronApp.evaluate`.

## Agents on this Mac (desktop only)

This is a section of the Connect screen for agents connected through the user's own session, running in the Mac app (`docs/connectors.md`).

| Element | `data-testid` |
|---|---|
| Section | `local-agents` |
| Service cards | `local-service-<id>`, one each for `local-service-grokbot`, `local-service-muse` and `local-service-dots` |
| Connect-flow panel | `local-login` |
| Flow status text | `local-login-status` |
| Cancel | `local-login-cancel` |
| Error | `local-login-error` |
| Choice buttons (e.g. which Grok bot) | `local-login-choice-<id>` |
| Connector rows | `local-connector-row`, with `data-service` and `data-status` (`ready`, `starting`, `needs_login`, `error`) |
| Row buttons | `local-connector-open` (shows the service's own window), `local-connector-remove` |

Connecting signs in to the service:

- **Grok Bot:** in the browser.
- **Muse and Dots:** in an AgentRoom sign-in window.

The app then registers the connector with the agents bridge. After that the agent is a normal contact on every client, but it answers only while the Mac app runs.

Approval cards from connectors use the choice keys the connector sends:

- **Grok Bot:** the widget's values.
- **Page buttons:** `b<index>`.

### Agent onboarding and autonomous group participation

| Surface | `data-testid` |
| --- | --- |
| Contacts / new-chat entry | `im-onboarding-open`, `im-new-onboarding` |
| Preparation dialog | `im-onboarding`, `im-onboarding-agent`, `im-onboarding-goal` |
| Source controls | `im-onboarding-context`, `im-onboarding-recent`, `im-onboarding-memories` |
| Start/progress/cancel | `im-onboarding-start`, `im-onboarding-status`, `im-onboarding-cancel`, `im-onboarding-result` |
| Suggestions/adoption | `im-role-suggestion`, `im-adopt-role` |

The default member policy is `auto`; each available member reads independently and can answer in its own style with text, a message reaction or silence. Group queued/running runs have no promised reply bubble; the header reports aggregate activity and execution details retain precise stop/error controls. Completed silent/reaction runs create no chat bubble. Their reasons remain in execution details, and model failure is never displayed as a silence decision. Explicit member policies remain selectable through `im-policy-<contactId>`.

### Contact profiles, goals, schedules and local discovery

Imported contact labels use a compact heading or a stable service label. The original provider name remains searchable in contacts and private conversations, appears on contact-row hover, and can be expanded in the detail or editor. The editor saves an explicit display name and offers an explicit suggested-name action; it never replaces a chosen name silently.

IM preferences use `personal-tab-im`, `im-preferences`, and `im-allow-silence`; silence defaults on and the versioned setting affects subsequent accepted messages. Group information uses `im-group-silence` for inherit/allow/require response. Each message exposes `im-react-<messageId>` and `im-react-choice-<messageId>-<emoji>`; reaction chips use `im-reactions-<messageId>` / `im-reaction-<messageId>-<emoji>`, actor names in their accessible label/title, and `aria-pressed` for the owner's reaction. Chat bubbles do not show read receipts. Reaction chips show only the emoji for one actor and include a count for two or more actors. Reactions survive reload; acknowledged input receipts remain in execution details. Reaction controls are keyboard accessible and remain within narrow layouts.

The quiet `im-chat-info` header displays the peer/group and status (`im-header-status`), without model metadata. Clicking a peer opens an in-place profile; clicking a group opens group information. Inspecting member configuration does not change membership. Profile/basic editors preserve the underlying chat, draft and reading position.

| Surface | `data-testid` |
| --- | --- |
| Profile entry / root / basic editor | `im-agent-profile-open`, `im-agent-profile`, `im-agent-basic` |
| Per-member profile | `im-member-profile-<contactId>` |
| Goal / status / control state | `im-agent-goal`, `im-agent-goal-status`, `im-agent-control`, `im-agent-state` |
| Schedule fields | `im-agent-schedule-enabled`, `im-agent-schedule-mode`, `im-agent-schedule-time`, `im-agent-schedule-timezone`, `im-agent-schedule-interval`, `im-agent-schedule-limit` |
| Capability / timing | `im-agent-unsupported`, `im-agent-autonomous-hint`, `im-agent-next-run`, `im-agent-last-reason` |
| Mutations / recovery | `im-agent-save`, `im-agent-run-now`, `im-agent-pause`, `im-agent-unsaved`, `im-agent-error`, `im-agent-reload`, `im-agent-notice` |
| Run history / system trigger | `im-agent-history`, `im-agent-run-<runId>`, `im-agent-run-open-<runId>`, `im-schedule-event` |
| MCP explicit planner | `im-contact-chat-backend`, `im-contact-chat-backend-hint` |
| Discovery entry / body / contact | `im-discovery-entry`, `im-host-discovery`, `im-discovery-contact` (`data-contact-id`), `im-discovery-open-<contactId>` |
| Discovery actions / state | `im-discovery-refresh`, `im-discovery-retry`, `im-discovery-empty`, `im-discovery-more`, `im-discovery-prepare`, `im-discovery-connect`, `im-discovery-details` |

Schedules start disabled. Run Now requires a saved active goal. Pause turns off later scheduling and invalidates queued ticks; it does not claim to stop an operation already sent. Save conflict/network errors preserve editing. App exit and Mac sleep suspend scheduling. Fixed remote schedules do not claim structured autonomy. Human contacts remain local-only until an actual messaging transport exists.

The personal approval card (`personal-decision`) also renders `provider_approval` questions from Grok Bot. Its `personal-decision-<opaque key>` buttons retain each provider label. Sending/unknown states disable further choices; resolved cards display the selected label and original-app/AgentRoom source. Native permission cards explain that the action belongs in Grok Bot and synchronize the result without offering a permission grant. Independent cards open their bot’s direct conversation without a synthetic run.

The same card appears in its original chat beside the relevant run, or as a standalone provider request. Inbox and chat share the decision ID, version and command path. Provider delivery says only that the choice was delivered; later execution is not inferred. Supported MCP cards offer explicit exact-operation reuse behind a disclosure (same parameters/readback, one hour, ten operations), show remaining uses/expiry after reload and allow revoking future use. Only an actual available native opener renders the original-app button. `node dev/decisions-acceptance.mjs` checks these paths with an isolated MCP fixture and synthetic provider observations, including a narrow screen; it never approves a real provider request.

### Shared artifact coauthoring (personal desktop)

The `im-nav-library` entry opens the independent artifact library. `library-artifact-<artifactId>` opens the same work across chats. Discussion cards use host-owned records, with `creation-card`, `creation-scope`, `creation-approve`, `creation-adjust`, `creation-edit-goal`, `creation-save` and `creation-reject`. A decision binds the displayed version; approving an old card fails rather than executing a changed plan.

`library-empty` distinguishes an empty library from no search matches. `library-clear-search` clears the query and restores search focus; `library-start-group` opens an unselected group editor when the library is empty. `library-welcome` explains creating a first work or selecting an existing one; its empty-library action is `library-welcome-start`. A new group from the library does not inherit the last private chat's participant.

`artifact-tool-activity` lists actual scoped tool operations. `artifact-permission-card` opens `artifact-permission-review` into owner-only `artifact-owner-permission`; `artifact-permission-audience` lists exact recipients and `artifact-permission-approve/reject/revoke` decides scope. Private work details use `collaboration-owner-review` / `artifact-owner-work`; `collaboration-stopped-confirm`, `collaboration-abandon` and `collaboration-adopt-saved` reconcile unknown attempts after explicit owner review. `artifact-result-card`, `artifact-open`, `collaboration-stop` and `collaboration-retry` show real contributions and partial/unknown outcomes. Collaboration runs do not expose ordinary chat retry controls.

The `artifact-workspace` contains `artifact-revision-select`, tabs `artifact-tab-preview/files/history/activity/permissions`, isolated `artifact-preview`, `artifact-file`, `artifact-file-content`, `artifact-editor`, `artifact-edit-save`, `artifact-revision`, `artifact-accept`, `artifact-restore` and `artifact-archive`. Native actions use `artifact-reveal` and `artifact-export`. Sharing uses `artifact-share`, `artifact-share-thread`, `artifact-share-paths`, `artifact-share-follow` (unchecked by default), `artifact-share-confirm`, `artifact-share-notice` and `artifact-share-revoke`. Group results and linked cards open their explicit revision in the URL (`artifact` + `revision`); invalid versions never fall back to head. The library alone defaults to head. `artifact-owner-operation` / `artifact-owner-abandon` exposes unknown owner file receipts. Human Finder changes appear in `artifact-local-warning` and are preserved until explicitly coordinated.

### Personal remote server nodes

| Control | data-testid |
| --- | --- |
| Server settings section / add | `personal-remote-nodes`, `personal-node-add` |
| Enrollment form / address / private token / save | `personal-node-form`, `personal-node-url`, `personal-node-token`, `personal-node-save` |
| Node / check / remove agent / error | `personal-node-row`, `personal-node-check`, `personal-node-agent-remove`, `personal-node-error` |

Added agents use the existing contact, direct-message and group test IDs. Connectivity labels are last-check observations rather than continuous presence.

Native service recovery keeps the existing `im-run-status` and `im-execution-record` selectors. Group failure labels include the original Bot name, and a known unsent failure reads “未发送”. Unknown runs without a task receipt offer “检查连接”; this opens connection preferences without issuing a task query. `personal-service-instance` includes a safe avatar, while `personal-service-missing` retains an owned legacy connection whose service metadata is unavailable. Missing credential records cannot be removed through a nonexistent native instance.



### Unread chat indicators

Incoming completed replies show red count badges on conversation portraits (`im-unread-<id>`), pinned shortcuts (`im-pinned-unread-<id>`) and the chats rail icon (`im-unread-total`). Zero hides the badge; counts above 99 show `99+` while accessible labels retain the exact count. Approval indicators retain their separate appearance. Earlier replies can be expanded with `im-load-more`. The filter `im-filter-unread` combines unread state with the current search and uses “没有未读消息” when empty.

Opening a visible focused chat clears unread only after its latest incoming reply is displayed in the timeline viewport. A late reply inserted beside an earlier question remains unread until that reply is visible. A background/unfocused window, another screen, narrow list view, a covering modal or scrolling through history preserves unread. Reading does not reorder chats. Read state belongs to the SQLite workspace and survives restart; existing transcripts start read on the first upgrade.

### Agent role portraits (GET-517)

`im-avatar-mode-robot` selects local generated portraits; `im-avatar-mode-provider` uses the assistant original image. `im-agent-appearance` contains `im-avatar-preview`, `im-avatar-candidate-0` through `-3`, `im-avatar-regenerate`, `im-avatar-palette-<blue|violet|orange|teal|rose>`, `im-avatar-eyes`, `im-avatar-mouth`, `im-avatar-top`, `im-avatar-motion` and `im-avatar-state-<idle|thinking|working|waiting|completed>`. Previews never run work. The chosen descriptor persists with the contact and accepted run snapshots.

Generated images report `data-avatar-source="bottts"`. Current portraits expose `data-activity` (idle, queued, thinking, working, waiting, completed, attention); history retains accepted appearance and stays still. Thinking breathes, execution or verification orbits, waiting pulses amber, completion confirms once for 1.7 seconds. Uncertain/failed states stay still. Reduced/disabled motion, offscreen portraits and hidden documents stop animation. No percentage or inferred tool call is displayed.

The contact directory includes discovered local agents before adoption, including unavailable entries with an explicit state. The saved address book used for chat selection remains separate. Unsupported or uninstalled Agents cannot start chat through the directory button or double-click; guest and legacy group identities remain outside the personal directory.

Global personal workspace operation errors use `im-error`.


### CC Switch configuration inventory

Connections → 这台 Mac includes collapsed `personal-cc-switch` details. Client summaries use `personal-cc-switch-<codex|claude|pi|gemini|opencode>`. Read failure renders `personal-cc-switch-unavailable`, with retry through existing `personal-integrations-refresh`; an absent database renders nothing. MCP/Skills names expand progressively. Unknown schema values say 未识别. Configuration does not grant execution or import extensions into contacts.
