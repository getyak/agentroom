import { AgentAvatarEditor } from "./AgentAvatarEditor";
import { defaultAgentAvatar } from "./agent-avatar";
import { useRef, useState } from "react";
import { Check, Plus, Settings2, Users } from "lucide-react";
import { api, key } from "./api";
import { Modal } from "./ConversationPanels";
import { GroupAvatarEditor } from "./GroupAvatarEditor";
import { Avatar, groupAvatarMembers, avatarIcons, avatarLabels } from "./ContactAvatar";
import { AgentOptions } from "./AgentOptions";
import { suggestContactName } from "../server/contact-names.mjs";
export { Avatar } from "./ContactAvatar";
import type { AgentAvatar, AgentConfiguration, Contact, ResponsePolicy, Thread } from "./types";

export const availabilityText: Record<Contact["availability"], string> = {
  ready: "已连接", configuration_required: "需要完善配置", self: "本人", local_only: "本地联系人 · 尚未接入消息网络",
  unsupported: "已发现 · 暂不支持执行", not_installed: "尚未安装", login_required: "需要登录", disconnected: "连接已移除",
};
export function ContactEditor({ contact, contacts, initialKind = "agent", onClose, onSaved, onRefresh }: {
  contact?: Contact; contacts: Contact[]; initialKind?: "agent" | "human"; onClose: () => void; onRefresh: () => Promise<void>; onSaved: (contact: Contact) => Promise<void>;
}) {
  const backends = contacts.filter(c => c.kind === "agent" && c.discovered);
  const preferred = backends.find(c => c.availability === "ready" && c.binding?.type === "local") || backends.find(c => c.availability === "ready") || backends[0];
  const [kind] = useState(contact?.kind || initialKind);
  const [backend, setBackend] = useState(JSON.stringify(contact?.binding || preferred?.binding || null));
  const selectedBackend = backends.find(c => JSON.stringify(c.binding) === backend);
  const isToolConnection = selectedBackend?.binding?.type === "connection" && selectedBackend.connectionType === "mcp";
  const [chatBackend, setChatBackend] = useState(contact?.chatBackend ? JSON.stringify(contact.chatBackend) : "");
  const chatBackends = backends.filter(c => c.binding?.type === "local" && ["ready", "configuration_required"].includes(c.availability));
  const selectedChatBackend = backends.find(c => c.binding?.type === "local" && JSON.stringify(c.binding) === chatBackend);
  const effectiveBackend = isToolConnection ? selectedChatBackend : selectedBackend;
  const [name, setName] = useState(contact?.name || preferred?.name || "");
  const serviceName = contact?.avatarService ? { grokbot: "Grok Bot", muse: "Muse", dots: "ChatGPT Dots", cue: "Cue" }[contact.avatarService] : null;
  const suggestedName = contact?.sourceName ? suggestContactName(contact.sourceName, serviceName || (contact.connectionType === "mcp" ? "工具助手" : "个人助手"), contact.handle) : "";
  const [handle, setHandle] = useState(contact?.handle || `agent-${key().slice(0, 6)}`);
  const [description, setDescription] = useState(contact?.description || "");
  const [instructions, setInstructions] = useState(contact?.instructions || "");
  const [color, setColor] = useState(contact?.color || "blue");
  const [avatar, setAvatar] = useState<AgentAvatar | null>(() => contact ? contact.avatar === undefined ? (!contact.discovered && (!contact.icon || contact.icon === "auto") && !contact.avatarDataUrl && !contact.avatarService ? defaultAgentAvatar(contact) : null) : contact.avatar : defaultAgentAvatar({ id: key() }));
  const [icon, setIcon] = useState(contact?.icon || "auto");
  const [configuration, setConfiguration] = useState<AgentConfiguration>(contact?.configuration || { modelMode: "follow", thinking: "follow" });
  const [refreshing, setRefreshing] = useState(false);
  const [identityNotice, setIdentityNotice] = useState("");
  const extractIdentity = async () => {
    setRefreshing(true); setError("");
    try {
      const result = await api<{ instructions: string; sources: string[]; truncated: boolean }>("/integrations/local/pi/identity", {});
      if (result.instructions) { setInstructions(result.instructions); setIdentityNotice(`已读取 ${result.sources.join("、")}${result.truncated ? " 的前 3000 字" : ""}，请检查后保存。`); }
      else setIdentityNotice("未发现 Pi 保存的 SYSTEM.md 或 APPEND_SYSTEM.md，可以直接在下方定义身份。");
    } catch (e) { setError(e instanceof Error ? e.message : "无法提取身份"); }
    finally { setRefreshing(false); }
  };
  const refreshProfile = async () => { setRefreshing(true); setError(""); try { await api("/integrations/refresh", {}); await onRefresh(); } catch (e) { setError(e instanceof Error ? e.message : "无法读取配置"); } finally { setRefreshing(false); } };
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const pending = useRef<{ signature: string; clientId: string } | null>(null);
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const fields = { kind, name, handle, description, instructions, color, icon, avatar: kind === "agent" ? avatar : null, ...(kind === "agent" ? { configuration, chatBackend: isToolConnection && chatBackend ? JSON.parse(chatBackend) : null } : {}), binding: kind === "agent" ? JSON.parse(backend) : null, ...(contact ? { version: contact.version } : {}) };
      const signature = JSON.stringify(fields);
      if (pending.current?.signature !== signature) pending.current = { signature, clientId: key() };
      const saved = await api<Contact>(contact ? `/contacts/${contact.id}` : "/contacts", { ...fields, clientId: pending.current.clientId });
      await onSaved(saved);
    } catch (e) { setError(e instanceof Error ? e.message : "联系人尚未保存，请重试"); }
    finally { setBusy(false); }
  };
  return <Modal title={contact ? "编辑联系人" : kind === "agent" ? "自定义角色" : "添加人类联系人"} className="im-dialog" onClose={onClose}>
    <form className="im-form" onSubmit={event => { event.preventDefault(); void submit(); }} data-testid="im-contact-editor" onInvalid={event => { let ancestor: HTMLElement | null = event.target as HTMLElement; while (ancestor && ancestor !== event.currentTarget) { if (ancestor instanceof HTMLDetailsElement) ancestor.open = true; ancestor = ancestor.parentElement; } }}>
      {kind === "agent" && <>
        <label>使用哪个助手<select value={backend} disabled={contact?.discovered || refreshing} onChange={e => { const next = backends.find(c => JSON.stringify(c.binding) === e.target.value); if (!contact && name === selectedBackend?.name) setName(next?.name || ""); setBackend(e.target.value); setChatBackend(""); setConfiguration({ modelMode: "follow", thinking: "follow" }); }} data-testid="im-contact-backend">
          {!backends.length && <option value="null">请先在设置中连接助手</option>}
          {backends.map(c => <option key={c.id} value={JSON.stringify(c.binding)}>{c.providerName || c.name} · {availabilityText[c.availability]}</option>)}
        </select></label>
        {isToolConnection && <>
          <label>聊天助手<select value={chatBackend} disabled={refreshing || busy} data-testid="im-contact-chat-backend" onChange={event => { setChatBackend(event.target.value); setConfiguration({ modelMode: "follow", thinking: "follow" }); }}><option value="">请选择聊天助手</option>{chatBackend && !chatBackends.some(c => JSON.stringify(c.binding) === chatBackend) && <option value={chatBackend} disabled>{selectedChatBackend?.name || "原聊天助手"} · 当前不可用</option>}{chatBackends.map(c => <option key={c.id} value={JSON.stringify(c.binding)}>{c.providerName || c.name} · {availabilityText[c.availability]}</option>)}</select></label>
          <p className="im-field-hint" data-testid="im-contact-chat-backend-hint">{chatBackend ? "这位本机助手负责对话与规划，原工具连接保持不变。工具操作仍需逐项确认。" : "这是工具连接。选择聊天助手并保存后，才能发送新消息。可以先保存联系人，稍后补齐。"}</p>
        </>}
      </>}
      <div className="im-identity-preview"><Avatar contact={{ name: name || "A", color, kind, icon, avatar, binding: selectedBackend?.binding || null, avatarService: selectedBackend?.avatarService, avatarDataUrl: selectedBackend?.avatarDataUrl }} size="large" /><span>{name || "新的联系人"}<small>@{handle}</small></span></div>
      <label>显示名称<input autoFocus required maxLength={80} value={name} onChange={e => setName(e.target.value)} data-testid="im-contact-name" /></label>
      {contact?.sourceName && <details className="im-contact-source" data-testid="im-contact-name-source"><summary>原服务名称</summary><p>{contact.sourceName}</p>{suggestedName !== name && <button type="button" className="im-text-button" data-testid="im-contact-name-suggestion" onClick={() => setName(suggestedName)}>使用建议短名：{suggestedName}</button>}</details>}
      {kind === "agent" && <>
        <label>身份与回复方式<textarea rows={4} maxLength={3000} disabled={refreshing} placeholder="例如：你是我的研究伙伴，先核对来源，再给出简洁结论。" value={instructions} onChange={e => setInstructions(e.target.value)} data-testid="im-contact-instructions" /></label>
        <p className="im-field-hint">身份和聊天记录保存在这台 Mac。更改身份从下一条消息起生效。</p>
      </>}
      <details className="im-contact-disclosure"><summary data-testid="im-contact-appearance">头像与外观</summary><div className="im-contact-disclosure-body">
      {kind === "agent" && <>
        <div className="im-segment" aria-label="头像来源">
          <button type="button" aria-pressed={Boolean(avatar) && icon === "auto"} data-testid="im-avatar-mode-robot" onClick={() => { setIcon("auto"); setAvatar(avatar || defaultAgentAvatar({ id: contact?.id || handle, name, description, color })); }}>角色头像</button>
          <button type="button" aria-pressed={!avatar && icon === "auto"} data-testid="im-avatar-mode-provider" onClick={() => { setIcon("auto"); setAvatar(null); }}>助手原头像</button>
        </div>
        {avatar && icon === "auto" && <AgentAvatarEditor name={name} value={avatar} onChange={next => { setAvatar(next); setColor(next.palette); }} />}
      </>}
      {(!avatar || kind === "human") && <div className="im-avatar-picker" aria-label="联系人图标">{Object.entries(avatarIcons).map(([id, Icon]) => <button key={id} type="button" aria-label={avatarLabels[id]} title={avatarLabels[id]} aria-pressed={icon === id} data-testid={`im-avatar-icon-${id}`} onClick={() => { setIcon(id); setAvatar(null); }}>{id === "auto" ? <Avatar contact={{ name: name || "A", color, kind, binding: selectedBackend?.binding || null, avatarService: selectedBackend?.avatarService, avatarDataUrl: selectedBackend?.avatarDataUrl }} size="small" /> : <Icon size={20} />}</button>)}</div>}
      {(!avatar || kind === "human") && <div className="im-colors" aria-label="头像颜色">{["blue", "violet", "teal", "orange", "rose"].map(c => <button className={`im-color ${c}`} type="button" key={c} aria-label={`${c}头像`} aria-pressed={color === c} onClick={() => setColor(c)}>{color === c && <Check size={15} />}</button>)}</div>}
      </div></details>
      <details className="im-contact-disclosure" open={Boolean(contact?.configurationError) || undefined}><summary data-testid="im-contact-advanced">{kind === "agent" ? "模型与更多设置" : "更多资料"}</summary><div className="im-contact-disclosure-body">
      <label>用户名<span className="im-field-hint">群聊中通过 @{handle} 提及</span><input required pattern="[a-z](?:[a-z0-9_]|-){1,31}" maxLength={32} value={handle} onChange={e => setHandle(e.target.value.toLowerCase())} data-testid="im-contact-handle" /></label>
      <label>简介<input maxLength={300} placeholder="一句话介绍这位联系人" value={description} onChange={e => setDescription(e.target.value)} data-testid="im-contact-description" /></label>
      {kind === "agent" && <>
        {(!isToolConnection || selectedChatBackend) && <AgentOptions profile={effectiveBackend?.profile} value={configuration} onChange={setConfiguration} refreshing={refreshing} onRefresh={() => void refreshProfile()} />}
        {effectiveBackend?.binding?.type === "local" && effectiveBackend.binding.localAgentId === "pi" && <div className="im-identity-import"><button type="button" className="im-text-button" disabled={refreshing || Boolean(instructions.trim())} data-testid="im-extract-identity" onClick={() => void extractIdentity()}>从 Pi 提取已保存的身份</button><p className="im-field-hint">{identityNotice || "读取 Pi 的全局身份文件，填入下方供你检查。已有身份请先清空，避免覆盖。"}</p></div>}
      </>}
      </div></details>
      {kind === "human" && <p className="im-callout">先保存到本机通讯录。对方尚不能收到消息，后续接入消息网络后再启用投递。</p>}
      {error && <p role="alert" className="im-error">{error}</p>}
      <button className="im-primary" disabled={busy || refreshing || (kind === "agent" && backend === "null")} data-testid="im-contact-save">{busy ? "正在保存…" : contact ? "保存更改" : "添加联系人"}</button>
    </form>
  </Modal>;
}

export function GroupEditor({ thread, contacts, initialMembers = [], onClose, onSaved, onOpenProfile }: {
  thread?: Thread; contacts: Contact[]; initialMembers?: string[]; onClose: () => void; onSaved: (thread: Thread) => Promise<void>; onOpenProfile?: (contact: Contact) => void;
}) {
  const [title, setTitle] = useState(thread?.title || "");
  const [members, setMembers] = useState(thread?.memberIds?.filter(x => x !== "self") || initialMembers);
  const [search, setSearch] = useState("");
  const [silence, setSilence] = useState(thread?.allowSilence === undefined || thread.allowSilence === null ? "inherit" : thread.allowSilence ? "allow" : "require");
  const [responsePolicies, setPolicies] = useState<Record<string, ResponsePolicy>>(thread?.responsePolicies || {});
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const request = useRef<{ signature: string; clientId: string } | null>(null);
  const pair = !thread && members.length < 2;
  return <Modal title={thread ? "群聊信息" : "选择聊天伙伴"} onClose={onClose} className="im-dialog">
    <form className="im-form" data-testid="im-group-editor" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError("");
      try {
        const fields = pair ? { kind: "direct", memberIds: members } : { kind: "group", title, memberIds: members, allowSilence: silence === "inherit" ? null : silence === "allow", ...(thread ? { version: thread.version, responsePolicies: Object.fromEntries(Object.entries(responsePolicies).filter(([id]) => members.includes(id))) } : {}) };
        const signature = JSON.stringify(fields);
        if (request.current?.signature !== signature) request.current = { signature, clientId: key() };
        const saved = await api<Thread>(thread ? `/chats/${thread.id}` : "/chats", { ...fields, clientId: request.current.clientId });
        await onSaved(saved);
      } catch (e) { setError(e instanceof Error ? e.message : "群聊尚未保存"); }
      finally { setBusy(false); }
    }}>
      {!pair && <><GroupAvatarEditor members={groupAvatarMembers(["self", ...members], contacts)} />
      <label>群名称<input autoFocus required maxLength={80} placeholder="例如：产品讨论" value={title} onChange={e => setTitle(e.target.value)} data-testid="im-group-name" /></label>
      <label>允许静默<select data-testid="im-group-silence" value={silence} onChange={event => setSilence(event.target.value)}><option value="inherit">跟随 IM 设置</option><option value="allow">允许：按角色选择回复、表情或保持安静</option><option value="require">关闭：需要文字或表情回应</option></select></label></>}
      {pair && <p className="im-callout" data-testid="im-pair-hint">选一位，开始私聊；再选一位，就能一起建群。</p>}
      <label>选择联系人<input type="search" placeholder="搜索名称或用户名" value={search} onChange={e => setSearch(e.target.value)} data-testid="im-group-search" /></label>
      <div className="im-member-picker">{contacts.filter(c => c.id !== "self" && `${c.name} ${c.handle}`.toLowerCase().includes(search.toLowerCase())).map(c => <div className="im-member-choice" key={c.id}>
        <label><input type="checkbox" checked={members.includes(c.id)} data-testid={`im-member-${c.id}`} onChange={e => setMembers(current => e.target.checked ? [...current, c.id] : current.filter(x => x !== c.id))} /><Avatar contact={c} /><span>{c.name}<small>{c.kind === "agent" ? c.providerName : "本地联系人"}</small></span></label>
        {thread && members.includes(c.id) && onOpenProfile && <button type="button" className="im-member-profile" aria-label={`查看${c.name}的设置`} title="联系人设置" data-testid={`im-member-profile-${c.id}`} onClick={() => onOpenProfile(c)}><Settings2 size={16} /></button>}
        {thread && members.includes(c.id) && c.kind === "agent" && <select aria-label={`${c.name}的响应策略`} data-testid={`im-policy-${c.id}`} value={responsePolicies[c.id] || "auto"} onChange={e => setPolicies(p => ({ ...p, [c.id]: e.target.value as ResponsePolicy }))}><option value="auto">按角色判断，可保持安静</option><option value="mention">仅提及或回复时</option><option value="always">每条消息</option><option value="manual">暂停回应</option></select>}
      </div>)}</div>
      <p className="im-field-hint">默认所有可用 Agent 独立读取消息，按自己的风格回复文字、回应表情，或在允许时保持安静；@ 表示明确找它。新成员只收到加入后的内容；已接受的运行保持原身份。人类成员当前仅保存在本机。</p>
      {error && <p role="alert" className="im-error">{error}</p>}
      <button className="im-primary" disabled={busy || !members.length} data-testid="im-group-save">{busy ? "正在保存…" : thread ? "保存群信息" : pair ? "开始私聊" : <><Plus size={17} />创建群聊</>}</button>
    </form>
  </Modal>;
}
