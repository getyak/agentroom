# Roomie local CLI defaults (GET-555)

Roomie should be ready to chat through an available local CLI without an extra backend choice. Reuse the existing priority: saved local default, Codex, Claude Code, Pi. Each candidate must be installed, authenticated, execution-supported and compatible with the companion's effective model settings. Opening or refreshing the workspace does not run a model.

## Approaches

Extend the existing WorkspaceGuide synchronization (chosen): it already receives fresh local discovery and owns first binding. A separate selector in Roomie would duplicate ranking and still miss the completed-onboarding path. Editing only the current database would leave other upgraded workspaces broken.

## Behavior

- Bind existing Roo contacts even after onboarding has completed, without creating another introduction or resetting onboarding.
- Upgrade the historical `agentroom_roomie` system identity to the normal guide chat path, preserving its ID, name, handle, persona, avatar, configuration, messages and runs. Retire only its legacy direct-chat routing marker; setup jobs retain their dedicated route.
- Preserve every existing binding. After first selection, login/model failures never switch providers automatically.
- Unbound guides show setup-required facts. Bound guides use Messenger's local profile/model/quota projection.
- No new permissions, models, credentials, automatic messages or remote connections.

## Acceptance

Cover ranking and saved defaults, unavailable/invalid candidates, effective fixed configuration, completed onboarding, historical Roomie restart/idempotency, preserved explicit connections and ordinary message dispatch through the selected CLI. Verify read-only discovery invokes no model.
