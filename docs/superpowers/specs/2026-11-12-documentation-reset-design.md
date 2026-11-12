# AgentRoom documentation reset

GET-519. The user selected documentation and a future implementation plan, not a runtime refactor. The canonical repository is getyak/agentroom.

## Outcome and approach

Rewrite both README languages around the released personal Mac app and Roo. Use focused architecture, detailed design, interaction design and roadmap documents, with an index and a future implementation sequence. Preserve the old mixed documents as dated history snapshots. Keeping all history in README makes current behavior hard to find; renaming runtime modules or packages would exceed this task and risk existing profiles.

## Contracts

- Distinguish configuration discovery from actual execution and account acceptance.
- Describe addressed A2A chat, approved tasks/tools, provider decisions and creation grants accurately.
- Mac/server sharing does not establish desktop DB sync or a general friend network.
- Preserve package names, bundle ID, profile paths, Go module and original notices/disclaimers.
- Use getyak/agentroom for new work and an independent local checkout to protect old active worktrees.
- This documentation task requires no app release, runtime dependency or model call.

## Validation

Trace current claims to source. Check changed Markdown links/paths, bilingual parity and remote/tracking configuration. Get a fresh factual/design review. Run applicable latest CI before merge, read back the issue/new main, and preserve original documents and task-owned recovery references before cleanup.
