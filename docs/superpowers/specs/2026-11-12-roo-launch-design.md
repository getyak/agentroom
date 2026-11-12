# Publish AgentRoom with Roo

User authorization: create and publish the project; repository belongs to `getyak`. Implement autonomously under the working agreement.

## Experience

A new workspace opens a persistent direct conversation with **阿屋 Roo**, the room's first companion. Roo uses the bundled AgentRoom mascot. Its introductory message identifies its backend and explains the next step. No model is invoked just by opening the application. The guide's inline card offers environment discovery, local contact selection, account connections, role suggestions, and device contact requests through existing product flows. An optional name field and a finish action preserve the existing owner-name/onboarding setting.

Roo is a real chat identity, backed by an installed local adapter. Select only installed, execution-supported, authenticated assistants whose effective model configuration validates. Prefer the owner's existing default, then Codex, Claude and Pi. This ordering is a product default based on supported adapters, not a model-quality benchmark. Show that configuration detection is not a successful execution probe. First chat uses the actual selected adapter and its accepted execution snapshot.

If no assistant qualifies, create the guide conversation with setup actions and explain that chat needs an installed and logged-in assistant. Once one becomes eligible, bind it exactly once. Later failures do not silently switch providers. Existing populated workspaces retain their normal entry; reopening onboarding creates/opens the guide deliberately. Repeated refreshes and restarts reuse the contact, conversation and introduction.

## Grounding and changes

Reuse Messenger, SQLite, the durable worker, host discovery, local-agent picker, role onboarding and existing connection/device controls. The guide receives a bounded, whitelisted host/configuration/contact projection with the accepted message; no credentials, absolute configuration paths, private conversations or raw configuration documents. Recommendations remain separate from actual adoption. Existing per-action approvals and contact request readback remain authoritative. Do not claim a contact was added or a request sent without a product receipt.

## Approaches

1. Permanent contact plus inline actions (chosen): matches the requested first-agent experience and reuses normal chat recovery.
2. A modal setup wizard: smaller UI change but disappears after setup and splits guidance from chat.
3. A separate autonomous installer agent: adds a second execution/recovery system and unnecessary machine permissions.

Raft is a behavior reference only: durable identities, guided discovery and receipt-backed actions. Independently implement the feature; do not copy Raft source or assets.

## Publication

Create `getyak/agentroom` as an independent public GitHub repository, preserving upstream history and Apache notices. Add a linked Linear issue and PR. Publish a versioned Apple Silicon macOS alpha with an archive, checksum, source revision and signing/notarization facts. Keep internal package names, bundle ID and profile paths compatible. A locally signed archive is not a notarized distribution; release copy must state the actual signature status. Do not replace the running user's application during release acceptance.

## Acceptance

Test fresh/old/no-backend workspaces, ranking and invalid models, persistence without duplicate introductions, accepted execution identity and context privacy. Verify first-entry selection, brand avatar, guide actions, finishing/reopening, narrow dark layout, and an isolated packaged native launch. Run applicable CI and independent review before merge. Publish only the clean merged revision. Existing account/device acceptance remains distinct from synthetic checks.
