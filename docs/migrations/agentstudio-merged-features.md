# Merged AgentStudio migration audit (GET-547)

Audited on 2026-11-14 against old `cubxxw/agentstudio` main `ed35045ff024d9fa4dde8509161ea1c7f122b830` and new `getyak/agentroom` main `a81f3af6a51658f2428180a710746f768c84b6b3`. All 52 merged old pull requests were checked by their merge commits, rather than titles or changed-file counts. The common ancestor is `67a472c7adb8278801ea6e374889ed5be9020509`: 45 merged PRs are ancestors of the new base; seven later merge commits were absent. No unmerged proposal is included.

## Seven divergent merges

| Old PR | Result in AgentRoom |
| --- | --- |
| #48 Guest rooms | Restored the separate bearer-scoped guest listener, invite acceptance, isolated Codex/Pi execution and historical room migration. Guest requests cannot reach owner APIs. Network publication remains an explicit owner action. |
| #49 Group collaboration | Restored group sharing, roster, notes, polls and quizzes. Ordinary group creation/additions use the newer `ChatTools` owner decisions. Legacy `group_create`/`group_add_agents` are adapters to pending approvals; `group_invite` prepares a draft. Old automatic publication becomes owner review. |
| #50 Member portraits | Already restored by GET-546/PR #18. Groups always compose current members; the old custom image/preset chooser is superseded by the owner's latest requirement. Legacy metadata stays stored. |
| #51 Workspace setup | Restored selected read-only projects, links, verified role/group suggestions, opt-in configuration monitoring and stop reconciliation in Roo's setup panel. Existing Roo identity/first-use flow remains; opening the panel creates no second default Roomie. Existing Roomie history and jobs remain compatible. Suggestions require explicit adoption; no model result silently creates a group or switches Roo's backend. |
| #52 Pair/group rules | One selected contact opens/reuses a DM; new groups require three distinct participants including the owner. Historical smaller groups retain their IDs and history. Human portraits and owner portrait are restored. |
| #53 Product avatar | Covered by Roo's existing product mascot. Historical Roomie identity also retains the app image. |
| #54 Anime portraits | Restored the six bundled fictional portraits with stable local identity mapping; no image network request. |

## Integration boundaries

- Guest and legacy group identities remain visible within their own group but are excluded from global contact discovery, invitations and Roo's global context.
- Published groups receive only reviewed public personas/context and group tools. Private ChatTools, MCP catalogs, project directories, memories and Library capabilities are excluded, with runtime checks as well as catalog filtering.
- Pending ChatTools/MCP decisions freeze and recheck publication state. A private action cannot survive publishing/replacing an invitation merely because membership/version stayed unchanged.
- Project and group artifact reads retain revocable provenance through replies, reactions, group notes, ChatTools, creation plans and MCP child runs. Group artifact writes check all current recipients; later reads recheck the source revision. The same public invitation may show public content to later guests. Unknown dependency kinds fail closed.
- No live conversation, membership, credential or queued approval is replaced by the migration. Native acceptance uses isolated profiles; installed-app upgrade checks are recorded separately.

PR #19 merged the missing history into AgentRoom main. The installed-app check also caught an inherited broad roster selector applying text-column layout to avatar spans; the follow-up confines that rule to member details and checks portrait geometry in owner, desktop guest and mobile guest rosters.

## Complete old merged-PR ledger

| PR | Merged feature | Merge | At new base |
| --- | --- | --- | --- |
| [#1](https://github.com/cubxxw/agentstudio/pull/1) | Build a personal agent workspace centered on conversations | `7d85801b` | Shared ancestry |
| [#2](https://github.com/cubxxw/agentstudio/pull/2) | Make the personal agent workspace feel at home on Mac | `0a116647` | Shared ancestry |
| [#3](https://github.com/cubxxw/agentstudio/pull/3) | [ImgBot] Optimize images | `39426e11` | Shared ancestry |
| [#4](https://github.com/cubxxw/agentstudio/pull/4) | Report the actual source version in the Mac app | `eaf065d9` | Shared ancestry |
| [#5](https://github.com/cubxxw/agentstudio/pull/5) | Connect local and personal agents with one click | `44056033` | Shared ancestry |
| [#6](https://github.com/cubxxw/agentstudio/pull/6) | Fix Muse sign-in in the Mac app | `10e16c27` | Shared ancestry |
| [#7](https://github.com/cubxxw/agentstudio/pull/7) | Build agent contacts, direct messages and group chats | `44f2c6e1` | Shared ancestry |
| [#8](https://github.com/cubxxw/agentstudio/pull/8) | Keep restored agent connections from blocking startup | `afa2113b` | Shared ancestry |
| [#9](https://github.com/cubxxw/agentstudio/pull/9) | Unify chats and existing tasks in one messenger | `83a533d4` | Shared ancestry |
| [#10](https://github.com/cubxxw/agentstudio/pull/10) | Select the personal window when checking restored connections | `a5fd1d78` | Shared ancestry |
| [#11](https://github.com/cubxxw/agentstudio/pull/11) | Polish live conversations and configurable agent contacts | `770c4a18` | Shared ancestry |
| [#12](https://github.com/cubxxw/agentstudio/pull/12) | Polish the Mac interface with native materials and focused reading | `0a85b448` | Shared ancestry |
| [#13](https://github.com/cubxxw/agentstudio/pull/13) | Let group agents choose when to reply and prepare roles during onboarding | `a5289ca4` | Shared ancestry |
| [#14](https://github.com/cubxxw/agentstudio/pull/14) | Give each Agent its own goal, schedule and chat settings | `1498aebc` | Shared ancestry |
| [#15](https://github.com/cubxxw/agentstudio/pull/15) | Refine agent avatars and simplify chat messages | `160d5173` | Shared ancestry |
| [#16](https://github.com/cubxxw/agentstudio/pull/16) | Rename AgentStudio to AgentRoom and add a fresh-start test mode | `b65e3523` | Shared ancestry |
| [#17](https://github.com/cubxxw/agentstudio/pull/17) | Give AgentRoom its own quiet visual style | `ae19ed3e` | Shared ancestry |
| [#18](https://github.com/cubxxw/agentstudio/pull/18) | Co-create persistent artifacts with Codex and Pi | `823dbbf7` | Shared ancestry |
| [#19](https://github.com/cubxxw/agentstudio/pull/19) | Refine the sidebar, search and pinned conversations | `34c07e72` | Shared ancestry |
| [#20](https://github.com/cubxxw/agentstudio/pull/20) | Fix Muse chat in the Mac app | `e25ebd71` | Shared ancestry |
| [#21](https://github.com/cubxxw/agentstudio/pull/21) | Polish window controls and navigation selection | `25d58d4a` | Shared ancestry |
| [#22](https://github.com/cubxxw/agentstudio/pull/22) | Use gray chat bubbles for agent replies | `ac9d323a` | Shared ancestry |
| [#23](https://github.com/cubxxw/agentstudio/pull/23) | Design macOS automatic updates with a restart indicator | `acb5c7cd` | Shared ancestry |
| [#24](https://github.com/cubxxw/agentstudio/pull/24) | Make Grok Bot messaging and approvals work end to end | `9eb6cbb1` | Shared ancestry |
| [#25](https://github.com/cubxxw/agentstudio/pull/25) | Make the chat scrollbar slimmer and quieter | `e4499e92` | Shared ancestry |
| [#26](https://github.com/cubxxw/agentstudio/pull/26) | Quickly add local agents and show useful agent cards | `476425ba` | Shared ancestry |
| [#27](https://github.com/cubxxw/agentstudio/pull/27) | Show each Grok Bot’s own avatar | `ac9b9fa0` | Shared ancestry |
| [#28](https://github.com/cubxxw/agentstudio/pull/28) | Give AgentRoom a mischievous room mascot icon | `b672dfa8` | Shared ancestry |
| [#30](https://github.com/cubxxw/agentstudio/pull/30) | Connect server agents over Tailscale | `89de1f22` | Shared ancestry |
| [#31](https://github.com/cubxxw/agentstudio/pull/31) | Stop repeated macOS Keychain prompts after local rebuilds | `e373847d` | Shared ancestry |
| [#32](https://github.com/cubxxw/agentstudio/pull/32) | Let agents read group messages concurrently and respond naturally | `6e3b0e92` | Shared ancestry |
| [#33](https://github.com/cubxxw/agentstudio/pull/33) | Simplify group read receipts and reaction counts | `c44edab2` | Shared ancestry |
| [#34](https://github.com/cubxxw/agentstudio/pull/34) | Polish interface details and everyday workflows | `8ea190f4` | Shared ancestry |
| [#35](https://github.com/cubxxw/agentstudio/pull/35) | Design group avatars and let people customize them | `e4c99d1d` | Shared ancestry |
| [#36](https://github.com/cubxxw/agentstudio/pull/36) | Polish the native AgentRoom menu labels | `548166fe` | Shared ancestry |
| [#37](https://github.com/cubxxw/agentstudio/pull/37) | Show the contact and Bot behind each approval | `990f414a` | Shared ancestry |
| [#38](https://github.com/cubxxw/agentstudio/pull/38) | Keep native App tests in the background and verify the build version | `7f7b3f32` | Shared ancestry |
| [#39](https://github.com/cubxxw/agentstudio/pull/39) | Capture input events when interface checks fail | `8378f52f` | Shared ancestry |
| [#40](https://github.com/cubxxw/agentstudio/pull/40) | Polish mentions, draft attachments, and approval requests | `949c24f7` | Shared ancestry |
| [#41](https://github.com/cubxxw/agentstudio/pull/41) | Render Markdown in conversation list previews | `d70c057b` | Shared ancestry |
| [#42](https://github.com/cubxxw/agentstudio/pull/42) | Show unread message badges in chats | `844da82c` | Shared ancestry |
| [#43](https://github.com/cubxxw/agentstudio/pull/43) | Connect AgentRoom devices and show contact presence | `6c2309cb` | Shared ancestry |
| [#44](https://github.com/cubxxw/agentstudio/pull/44) | Restore Grok and Muse connections and delivery status | `de4d9876` | Shared ancestry |
| [#45](https://github.com/cubxxw/agentstudio/pull/45) | Give agents consistent avatars with expressive status animations | `7ec6b92e` | Shared ancestry |
| [#46](https://github.com/cubxxw/agentstudio/pull/46) | Show the sender clearly on every approval | `67a472c7` | Shared ancestry |
| [#48](https://github.com/cubxxw/agentstudio/pull/48) | Invite friends to playful agent rooms without an account | `ec29576c` | Restored/adapted below |
| [#49](https://github.com/cubxxw/agentstudio/pull/49) | Integrate sharing and agent tools into group chats | `8296687b` | Restored/adapted below |
| [#50](https://github.com/cubxxw/agentstudio/pull/50) | Show group members together in the group avatar | `3549d464` | Restored/adapted below |
| [#51](https://github.com/cubxxw/agentstudio/pull/51) | Let Roomie set up local agents, projects, and group chats | `d81d2337` | Restored/adapted below |
| [#52](https://github.com/cubxxw/agentstudio/pull/52) | Keep pairs in direct chats and give everyone a visual avatar | `9c6952fe` | Restored/adapted below |
| [#53](https://github.com/cubxxw/agentstudio/pull/53) | Use the AgentRoom app icon as Roomie’s avatar | `8088a335` | Restored/adapted below |
| [#54](https://github.com/cubxxw/agentstudio/pull/54) | Give people expressive anime avatars | `ed35045f` | Restored/adapted below |
