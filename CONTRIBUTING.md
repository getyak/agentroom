# Contributing to AgentRoom

Development now happens at **[getyak/agentroom](https://github.com/getyak/agentroom)**. Open new issues and PRs here, targeting `main`. The [repository guide](docs/repository.md) explains existing checkouts and the internal AgentStudio identifiers that remain compatible.

## Before you start

Report bugs with a reproduction and the version/commit. For security problems use [SECURITY.md](SECURITY.md) privately. Discuss substantial features before implementation; [the roadmap](docs/roadmap.md) distinguishes shipped behavior from future proposals.

Read [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md), [detailed design](docs/detailed-design.md), [API](docs/api.md) and [client test IDs](docs/clients.md). Update the relevant contract in the same change when behavior changes.

## Personal desktop setup

Use macOS, Node **22.13+** and the pnpm version pinned in `package.json`:

```sh
git clone https://github.com/getyak/agentroom.git
cd agentroom
pnpm install --frozen-lockfile
pnpm --filter @agentstudio/core build
pnpm dev:desktop
```

A real model conversation also needs a supported installed/signed-in CLI. `pnpm dev:desktop:test` isolates application data, but external CLI accounts and quota may remain shared. Do not use real account data in fixtures.

The default desktop does not need Go, PostgreSQL or Synapse. Work on the retained Matrix route has its own [setup and tests](docs/legacy-matrix.md). Builds and packaging are documented in [apps/desktop](apps/desktop/README.md).

## Make the change

Start from fresh `origin/main`. Use a separate worktree for parallel work and preserve unrelated changes. New task branches use `codex/<issue-id>-<description>` when following the project's Linear workflow.

- TypeScript uses strict ESM and React function components. `@agentstudio/core` must not import DOM, Node or React Native APIs.
- Keep accepted identities/configuration, idempotency, membership visibility and unknown-result recovery intact.
- Follow [the current interaction design](docs/design.md). Use existing product/service assets and generated-avatar rules; preserve user-selected images and attribution.
- Tests select documented `data-testid` values and wait on observable conditions.
- Go changes use `-tags nocrypto`, `log/slog`, and no message-body/token logging. Keep its existing module path until a separate migration is designed.
- Keep diffs focused; a directory move or rename needs a concrete compatibility reason.

## Validate the affected path

```sh
pnpm --filter @agentstudio/personal typecheck
pnpm test:personal
pnpm --filter @agentstudio/desktop typecheck
pnpm --filter @agentstudio/desktop test
```

`pnpm test` runs the wider dev/Go/workspace suites and requires Go. CI runs typechecks, builds, unit tests and personal browser journeys on the checked commit; `workflow_dispatch` also supports explicit runs. Build before browser/native acceptance. Use `launchDesktopTest` for isolated native automation, default to hidden windows, and record whether evidence is renderer-only or an OS capture.

For documentation changes, verify links and factual claims against source without starting account flows or rebuilding unrelated native stacks. For protocol/storage/recovery changes, run the corresponding suites and meaningful failure cases. Passing a synthetic test does not establish a real login, physical device or notarized upgrade.

## Third-party connections

Connectors reach your own agents with your own accounts on your own Mac. Preserve the [personal-use disclaimer](README.md#disclaimer); do not add scale automation, other people's account access or ways around service limits/protections. Debug only in an isolated environment and scrub fixtures to structure. Never commit real transcripts, cookies, tokens or credentials.

## Send it

Open the PR against **`getyak/agentroom:main`**, with the concrete problem, resulting behavior and relevant validation. Link the associated Linear issue where applicable. Risky changes receive independent review; merge only after applicable latest CI and repository gates pass. Close delivery issues after their actual acceptance, then read back the result.

By contributing, you agree that your contribution is under [Apache-2.0](LICENSE). Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md).
