# Local assistants first when adding contacts

Approved direction: the user explicitly requested implementation on 2026-11-14.

Opening Add Contact shows installed local assistants and one action per row. A configured, supported assistant can be added and its existing direct chat opened in one click, without sending a message. Already added assistants open their existing chat. Login/configuration problems link to setup rather than claiming execution has been verified. Unsupported installed assistants are secondary and cannot be added as chat agents.

Rank configured supported environments first, then recent conversations within each readiness group, then a stable name order. Recent conversation is not evidence of successful execution. Discovery never runs a model. No brand receives a hardcoded ranking preference. Existing stable contacts, accepted identities, model configuration and chat history remain unchanged.

Custom roles and human contacts are secondary actions. The role editor puts the assistant binding before identity fields, keeps name and instructions visible, and discloses avatar, username, biography and model settings on demand. Existing custom settings are retained when their section is closed.

Use the existing system font and semantic Messenger palette: white reading surface, #27343e text, #5d6b77 secondary text, #35627b focus/actions and #294f68 primary actions, with existing dark-theme counterparts. Left-aligned single-column rows, recognizable service portraits, generous row spacing, quiet dividers and no decorative cards. Narrow windows wrap actions without horizontal overflow. Keyboard focus and reduced motion follow existing controls.

Alternatives considered: retaining the identity form first leaves the core ordering problem; a model-driven setup wizard adds latency and decisions. The approved local-first list reuses existing adoption and direct-chat APIs.

Acceptance: one-click adoption/open; repeated clicks and lost responses reuse original requests; a failed chat open preserves adoption and offers retry; refresh preserves visible rows; empty, signed-out and unsupported states; secondary role/human paths; keyboard, narrow and dark appearance; host tests plus synthetic browser/native checks. Real account login and provider execution are distinct from these UI checks.
