import type { CSSProperties } from "react";
import { robotAvatarUrl, defaultAgentAvatar, avatarPalettes, activityLabels, observeAvatar } from "./agent-avatar";
import "./agent-avatar.css";
import { Brain, Code2, Compass, FileText, PenLine, Search, Sparkles, SquareTerminal, UserRound } from "lucide-react";
import codexIcon from "@agentstudio/brand/assets/chatgpt.png";
import claudeIcon from "@agentstudio/brand/assets/claude.png";
import piIcon from "@agentstudio/brand/assets/pi.svg";
import geminiIcon from "@agentstudio/brand/assets/gemini.png";
import opencodeIcon from "@agentstudio/brand/assets/opencode.png";
import grokIcon from "@agentstudio/brand/assets/grokbot.png";
import museIcon from "@agentstudio/brand/assets/muse-mark.png";
import cueIcon from "@agentstudio/brand/assets/cue.png";
import roomIcon from "@agentstudio/brand/assets/agentstudio.png";
import { presenceText } from "./contact-presence";
import { GroupAvatar } from "./GroupAvatar";
import type { GroupAvatar as GroupAppearance } from "./types";
import type { AvatarActivity, Contact } from "./types";

export const avatarIcons = { auto: SquareTerminal, spark: Sparkles, code: Code2, research: Search, write: PenLine, compass: Compass, brain: Brain, person: UserRound };
export const avatarLabels: Record<string, string> = { auto: "助手头像", spark: "灵感", code: "代码", research: "研究", write: "写作", compass: "探索", brain: "思考", person: "伙伴" };
const agentImages: Record<string, string> = { codex: codexIcon, claude: claudeIcon, pi: piIcon, gemini: geminiIcon, opencode: opencodeIcon, grokbot: grokIcon, muse: museIcon, dots: codexIcon, cue: cueIcon };
export function Avatar({ contact, group, groupAvatar, activity, size = "" }: { contact?: Pick<Contact, "name" | "color" | "kind"> & Partial<Pick<Contact, "systemRole" | "icon" | "binding" | "avatarAgent" | "avatarService" | "avatarDataUrl" | "presence" | "id" | "handle" | "discovered" | "avatar" | "avatarActivity">>; activity?: AvatarActivity; group?: boolean; groupAvatar?: GroupAppearance | null; size?: string }) {
  if (group) return <GroupAvatar avatar={groupAvatar} size={size} />;
  const agent = contact?.avatarAgent || (contact?.binding?.type === "local" ? contact.binding.localAgentId : null);
  const Icon = avatarIcons[(contact?.icon || "auto") as keyof typeof avatarIcons] || SquareTerminal;
  const automatic = !contact?.icon || contact.icon === "auto";
  const botImage = contact?.avatarDataUrl && contact.avatarDataUrl.length <= 683_000 && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(contact.avatarDataUrl) ? contact.avatarDataUrl : undefined;
  const source = contact?.systemRole === "guide" ? "agentroom" : contact?.kind === "agent" && automatic ? botImage ? "bot" : agent || contact.avatarService : undefined;
  const providerImage = source === "agentroom" ? roomIcon : source === "bot" ? botImage : source && agentImages[source];
  const generated = contact?.systemRole !== "guide" && contact?.kind === "agent" && automatic ? contact.avatar || ((!providerImage || (contact.id && !contact.discovered && !contact.avatarService && contact.avatar !== null)) ? defaultAgentAvatar(contact) : null) : null;
  const image = generated ? robotAvatarUrl(generated) : providerImage;
  const live = activity || contact?.avatarActivity || { state: contact?.presence?.waiting ? "waiting" : contact?.presence?.running ? "working" : "idle" };
  const state = live.state === "completed" && (!live.completedAt || Date.now() - Date.parse(live.completedAt) > 5000) ? "idle" : live.state;
  const palette = generated ? avatarPalettes[generated.palette] : avatarPalettes[(contact?.color || "blue") as keyof typeof avatarPalettes] || avatarPalettes.blue;
  const variables = { "--avatar-accent": palette.color, "--avatar-soft": palette.soft } as CSSProperties;
  const initials = Array.from(contact?.name.trim() || "?").slice(0, /^[\x00-\x7f]/.test(contact?.name || "") ? 1 : 2).join("").toUpperCase();
  return <span ref={observeAvatar} className={`im-avatar ${contact?.color || "blue"} ${size} ${contact?.kind === "agent" ? "im-avatar-agent" : ""} ${generated ? "im-avatar-robot" : image ? `im-avatar-brand im-avatar-${source}` : !contact ? "im-avatar-group" : ""}`} data-testid="im-avatar" style={variables} data-activity={state} data-motion={generated?.motion === false ? "off" : "on"} title={contact?.kind === "agent" ? activityLabels[state] : undefined} data-avatar-source={generated ? "bottts" : image ? source : !contact ? "notes" : automatic || contact.kind === "human" ? "initials" : "custom"} role="img" aria-label={contact ? `${contact.name}${contact.kind === "agent" ? `：${activityLabels[state]}` : ""}` : "资料"}>
    {contact?.kind === "agent" && <span className="im-avatar-orbit" aria-hidden="true" key={`${state}-${live.runId || "preview"}`} />}
    {!contact ? <FileText size={23} strokeWidth={1.6} /> : image ? <img src={image} alt="" draggable={false} data-testid="im-avatar-image" /> : contact.kind === "human" || automatic ? initials : <Icon size={23} strokeWidth={1.8} />}
    {contact?.kind === "agent" && ["waiting", "attention", "queued", "completed"].includes(state) && <span className="im-avatar-state-mark" aria-hidden="true">{state === "waiting" ? "!" : state === "attention" ? "?" : state === "queued" ? "·" : "✓"}</span>}
    {contact?.presence && <span className={`im-presence-dot ${contact.presence.state}`} title={presenceText(contact)} data-testid="im-presence-dot" data-state={contact.presence.state} />}
  </span>;
}
