import type { Approval, Contact } from "./types";

export function approvalSender(approval: Approval, contact?: Contact) {
  const name = (contact?.name || approval.contact?.name || approval.source?.name || "").trim();
  const unnamed = /^new bot$/i.test(name);
  const provider = approval.source?.label && approval.source.label !== "来源待核对" ? approval.source.label : null;
  const identity = approval.source?.botId || (contact?.handle ? `@${contact.handle}` : approval.source?.connectionId);
  return {
    name: name && !unnamed ? name : identity ? `${provider || "未命名 Bot"} · ${identity}` : provider ? `${provider}（身份待核对）` : "发送者待核对",
    unnamed,
  };
}

export function approvalContact(approval: Approval, contacts: Contact[]) {
  if (!approval.contact) return undefined;
  const original = approval.contact;
  const current = contacts.find(contact => contact.id === approval.contact?.id);
  const connectionId = approval.source?.connectionId;
  const sameBackend = current && (connectionId ? current.binding?.type === "connection" && current.binding.connectionId === connectionId
    : current.binding?.type === "local" && current.binding.localAgentId === original.avatarAgent);
  // Names follow the address book. Backend identity and portraits follow this request.
  return { ...original, avatar: original.avatar ?? null,
    ...(current ? { name: current.name, handle: current.handle, color: current.color, icon: current.icon } : {}),
    ...(sameBackend ? { avatarDataUrl: current.avatarDataUrl, avatarService: current.avatarService } : {}),
    ...(connectionId ? { binding: { type: "connection" as const, connectionId }, avatarAgent: undefined } : {}),
    ...(approval.source?.label === "Grok Bot" ? { avatarService: "grokbot" as const } : {}),
  };
}
