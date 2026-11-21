import { defaultAgentAvatar, normalizeAgentAvatar, avatarChoices } from './agent-avatar.mjs';
import { digest } from './store.mjs';

export const contactIcons = ['auto', 'spark', 'code', 'research', 'write', 'compass', 'brain', 'person'];
const logoAgents = ['agentroom', 'codex', 'claude', 'pi', 'gemini', 'opencode'];
const logoServices = ['grokbot', 'muse', 'dots', 'cue'];
const pngPrefix = 'data:image/png;base64,';
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const maxPhotoBytes = 512_000;

function validPhoto(bytes) {
  if (bytes.length < 33 || bytes.length > maxPhotoBytes || !bytes.subarray(0, 8).equals(pngSignature)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && width <= 256 && height > 0 && height <= 256;
}

export function contactPhoto(contact) {
  const url = contact.avatarDataUrl;
  if ((contact.icon && contact.icon !== 'auto') || contact.avatar || contact.systemRole === 'guide'
    || contact.id === 'agentroom_roomie' || typeof url !== 'string' || url.length > 683_000
    || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(url)) return null;
  const bytes = Buffer.from(url.slice(pngPrefix.length), 'base64');
  return validPhoto(bytes) ? bytes : null;
}

export function sharedAppearance(contact) {
  const color = avatarChoices.palette.includes(contact.color) ? contact.color : 'blue';
  if (contact.systemRole === 'guide' || contact.id === 'agentroom_roomie') {
    return { color, icon: 'auto', avatar: null, avatarAgent: 'agentroom' };
  }
  const icon = contactIcons.includes(contact.icon) ? contact.icon : 'auto';
  if (icon !== 'auto') return { color, icon, avatar: null };
  const localAgent = contact.binding?.localAgentId;
  const avatarAgent = logoAgents.includes(localAgent) ? localAgent : undefined;
  const avatarService = logoServices.includes(contact.avatarService) ? contact.avatarService : undefined;
  const photo = contactPhoto(contact);
  const renderRobot = !photo && !avatarAgent && !avatarService
    || Boolean(contact.id && !contact.discovered && !avatarService && contact.avatar !== null);
  const avatar = contact.avatar || (renderRobot ? defaultAgentAvatar(contact) : null);
  return { color, icon, avatar, ...(avatar ? {} : { avatarAgent, avatarService, ...(photo ? { photo: digest(photo) } : {}) }) };
}

// Only compact, allow-listed visual fields come from a device manifest.
export function readSharedAppearance(value) {
  if (!value || !avatarChoices.palette.includes(value.color) || !contactIcons.includes(value.icon)) return undefined;
  let avatar;
  try { avatar = value.avatar === null ? null : normalizeAgentAvatar(value.avatar); }
  catch { return undefined; }
  const appearance = { color: value.color, icon: value.icon, avatar };
  if (value.icon !== 'auto' || avatar) return appearance;
  if (logoAgents.includes(value.avatarAgent)) appearance.avatarAgent = value.avatarAgent;
  if (logoServices.includes(value.avatarService)) appearance.avatarService = value.avatarService;
  if (typeof value.photo === 'string' && /^[a-f0-9]{64}$/.test(value.photo)) appearance.photo = value.photo;
  return appearance;
}

export const peerAvatarId = (nodeId, agentId) => `${nodeId}:${agentId}`;

export async function fetchPeerPhoto(agent, headers, signal) {
  const photo = agent.appearance.photo;
  try {
    const response = await fetch(`${agent.url}/avatar`, { headers: { ...headers, Accept: 'image/png' }, signal, redirect: 'error' });
    if (!response.ok || response.headers.get('content-type') !== 'image/png') {
      await response.body?.cancel();
      return null;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxPhotoBytes) return null;
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    return validPhoto(bytes) && digest(bytes) === photo
      ? { photo, avatarDataUrl: pngPrefix + bytes.toString('base64') }
      : null;
  } catch {
    // A missing or interrupted photo can be retried at the next directory check.
    return null;
  }
}
