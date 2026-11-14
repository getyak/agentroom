# Clear member selection

The current group editor mixes settings, an unstructured directory and response policies in one scrolling form. Users cannot see where to start or which members they have chosen.

Use the existing React UI and AgentRoom colors. A bounded dialog keeps its title and footer visible. The left pane contains an autofocus search, All / AI / People filters, available assistants, people and a collapsed unavailable section. Stable name ordering never changes when a checkbox changes. Search matches names, usernames and sources, and reveals matching unavailable contacts. Each row shows a source and unique username; unavailable rows explain their status.

The right pane shows selected members independently of search, including the owner, a count and individual removal buttons. Unknown historical member IDs remain represented and preserved. Group name and live member collage remain visible when creating/editing a group. Silence settings and per-agent response policies live behind one disclosure. Contact profiles remain reachable beside selected members without losing the draft.

At narrow widths, stack panes with bounded independent lists. Search, selection feedback and save remain accessible. Use native checkboxes, visible keyboard focus, a polite selection count, semantic headings and existing dark/reduced-motion tokens.

Alternatives considered: merely sorting the old list would leave selected members invisible; a multistep wizard would add navigation to every small edit. The two-pane picker supports both discovery and quick review in one place. This is an implementation decision under the user's instruction to optimize autonomously.

Preserve request idempotency/version checks, original policies, the one-contact direct-chat rule, old groups and all existing data. No backend or membership permission changes. Validate long lists, duplicate names, absent historical contacts, search/filter retention, direct/group save, keyboard use, short/narrow windows, dark mode and save failure.
