# @agentstudio/brand

AgentRoom's own icon, and official images of the services AgentRoom connects to. The services' images appear only where AgentRoom names that service, for example on the Connect screen and as an agent's avatar fallback. Each one is a trademark of its owner, and none of these companies endorses AgentRoom.

| File | What | Source |
|---|---|---|
| `agentstudio.png` | AgentRoom's forest roommate: an original green doorway creature with uneven eyes and one tooth | Generated with the built-in imagegen tool on 2026-11-11; Apache-2.0 like the rest of the repo. [Design, source, prompts and native exports](../../docs/personal/brand/agentroom-icon.md). Reproduce PNG/ICNS variants with `swift dev/export-brand-icons.swift`. |
| `people-anime-*.png` | Six original anime human portraits for the owner and people contacts | Generated with built-in imagegen on 2026-11-13; Apache-2.0 like the repo. [Prompts and source](../../docs/personal/brand/people-anime-prompts.md). |
| `grokbot.png` | Grok Bot app icon | The macOS app bundle `Grok Bot.app/Contents/Resources/icon.icns` (0.78.3), cropped |
| `cue.png` | Cue app icon | The macOS app bundle `Cue.app/Contents/Resources/icon.icns` (1.0.12), cropped |
| `muse.jpg` | Muse mascot | `https://muse.ai/images/landing/brand/hatch.jpg` |
| `muse-mark.png` | Muse app mark (blue squiggle) | `https://muse.ai/images/favicon/app-squiggle.svg`, rendered at 256 px |
| `chatgpt.png` | ChatGPT logo (Dots runs in ChatGPT) | `https://chatgpt.com/cdn/assets/favicon-180x180.*.png` |
| `claude.png` | Claude mark | [Claude's official site icon](https://claude.com/icon.png), retrieved 2026-11-11 |
| `pi.svg` | Pi's three-color mark | [Pi's official site logo](https://pi.dev/logo-auto.svg), retrieved 2026-11-11 |
| `gemini.png` | Gemini CLI app icon | [Gemini CLI's official site icon](https://geminicli.com/icon.png), retrieved 2026-11-11 |
| `opencode.png` | OpenCode app icon | [OpenCode's official touch icon](https://opencode.ai/apple-touch-icon-v3.png), retrieved 2026-11-11 |
| `a2a.png` | A2A protocol icon | `a2aproject/A2A` `docs/assets/a2a_logo/icon/color/SVG/a2a_icon_color.svg`, rendered at 256 px |
| `acp.png` | Agent Client Protocol logo | `agentclientprotocol/agent-client-protocol` `docs/logo/fav-light.png` |
| `hermes.png` | Hermes Agent icon (Nous Research) | `NousResearch/hermes-agent` `assets/icon-master.svg`, rendered at 256 px |
| `openclaw.png` | OpenClaw mascot | `openclaw/openclaw` `apps/ios/WatchApp/Assets.xcassets/OpenClawIcon.imageset/openclaw-icon.png` |
| `matrix.png` | Matrix logo | `matrix-org/matrix.org` `static/images/matrix-favicon.svg`, rendered at 256 px |

Grok Bot's bot avatars (its shapes) are not shipped: the Mac app draws them on the user's Mac with the installed Grok Bot app's own code (see `apps/desktop/src/main/connectors/grokavatar.ts`).

AgentRoom's own UI icons come from [Lucide](https://lucide.dev) (ISC) on desktop and [Ionicons](https://ionic.io/ionicons) (MIT) on mobile.

## Generated role portraits

The personal renderer uses `@dicebear/core` and `@dicebear/bottts`, pinned to 9.4.2. Core is MIT; Bottts by Pablo Stanley is free for personal and commercial use. Sources: https://www.dicebear.com/styles/bottts/ and https://github.com/dicebear/dicebear/tree/9.4.2. The selected descriptor is saved, with no external image request. Existing product marks and real native Bot pictures remain available.
