# Agent-callable chat tools

The owner authorized implementation after comparing Linger's tool catalog. Reproduce the useful behavior in AgentRoom's own modules; do not copy Linger's additionally restricted source. Keep the Apache-2.0 project license unchanged.

## Design

Add one `ChatTools` policy layer around Messenger. Expose directory discovery, shared-room discovery, member lookup, message reading/search, group creation, Agent invitation, group messages and direct messages. Never expose credentials, private instructions or raw contact bindings. A directory entry does not imply a human can receive remote messages.

Reads require the requesting Agent and the source conversation's complete audience to share the target room and each returned message. Respect membership epochs, post-join boundaries, the accepted input cutoff and artifact provenance. Revalidate dependencies before publishing a reply. Directory discovery is restricted to contacts the owner has adopted.

Writes create an attributed, immutable, versioned `chat_action` approval in the source conversation. Owner approval executes the exact operation inside the store transaction and saves its real receipt. Rejecting has no chat side effect. Recheck actor binding, complete source/target membership, target version and contact bindings at approval. New-room membership is explicit; invitation only adds adopted Agents. Send messages as the requesting Agent, never as the owner, and do not recursively wake other Agents.

Local Codex, Claude and Pi use the existing private ToolSessions transport. A2A and native-service chats use a strict `tool_call` JSON envelope with bounded host-mediated rounds. Each remote round has a durable, distinct message identity and preserves uncertain-delivery reconciliation. Do not send tool bearer tokens or local callback endpoints to remote providers. Scheduled, onboarding, device-request and artifact-work runs remain outside chat tools.

## Implementation plan

1. Add policy tests for directory redaction, visibility, approvals, attributed writes, idempotency, stale membership/binding and cancellation; implement `chat-tools.mjs` with the shared catalog and private session.
2. Wire the owner decision route, catalog composition and local executor prompt. Add A2A tool rounds with persisted transcript and stable remote IDs; test local and remote adapters using synthetic fixtures.
3. Render understandable chat-action previews and result links with existing approval UI. Update API, architecture, client and connector contracts. Include the module in packaged desktop output.
4. Run focused tests, personal/desktop checks and isolated browser acceptance. Have an independent agent review complex changes, resolve confirmed P0/P1 findings, then create a Linear-linked PR, pass gates, merge and verify installed behavior.

## Review focus

- A group member cannot use another member's private conversation as a source.
- Leave/rejoin and binding changes invalidate old reads and pending writes.
- Later owner messages cannot silently enlarge an accepted input's context.
- Duplicate tool/approval calls and process recovery cannot duplicate a local write or remote dispatch.
- A tool-generated message is visibly attributed and does not start an autonomous reply storm.
