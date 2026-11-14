import ownerPortrait from "@agentstudio/brand/assets/people-anime-green.png";
import coralPortrait from "@agentstudio/brand/assets/people-anime-coral.png";
import skyPortrait from "@agentstudio/brand/assets/people-anime-sky.png";
import amberPortrait from "@agentstudio/brand/assets/people-anime-amber.png";
import violetPortrait from "@agentstudio/brand/assets/people-anime-violet.png";
import silverPortrait from "@agentstudio/brand/assets/people-anime-silver.png";

// Bundled fictional characters. Identity stays local and never becomes an image request.
const portraits = [coralPortrait, skyPortrait, amberPortrait, violetPortrait, silverPortrait];
export function humanAvatarUrl(contact: { id?: string; handle?: string; name: string; color?: string }) {
  const identity = contact.id || contact.handle || contact.name || "friend";
  if (identity === "self") return ownerPortrait;
  let seed = 2166136261;
  for (const char of identity) seed = Math.imul(seed ^ char.codePointAt(0)!, 16777619) >>> 0;
  return portraits[seed % portraits.length]!;
}
