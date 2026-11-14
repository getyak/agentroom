import "./group-editor.css";
import { AgentAvatarEditor } from "./AgentAvatarEditor";
import { defaultAgentAvatar } from "./agent-avatar";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Search, Settings2, Users, X } from "lucide-react";
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

const contactSource = (contact: Contact) => {
  if (contact.kind === "human") return contact.externalGuest ? "群聊访客" : "本机联系人";
  if (contact.providerName && contact.providerName !== contact.name) return contact.providerName;
  if (contact.binding?.type === "local") return ({ codex: "Codex", claude: "Claude Code", pi: "Pi", opencode: "OpenCode", gemini: "Gemini CLI", hermes: "Hermes" } as Record<string, string>)[contact.binding.localAgentId] || "ACP 助手";
  return contact.avatarService ? { grokbot: "Grok Bot", muse: "Muse", dots: "ChatGPT Dots", cue: "Cue" }[contact.avatarService] : contact.connectionType === "mcp" ? "工具助手" : "已连接的助手";
};

export function GroupEditor({ thread, contacts, initialMembers = [], onClose, onSaved, onOpenProfile }: {
  thread?: Thread; contacts: Contact[]; initialMembers?: string[]; onClose: () => void; onSaved: (thread: Thread) => Promise<void>; onOpenProfile?: (contact: Contact) => void;
}) {
  const [title, setTitle] = useState(thread?.title || "");
  const [members, setMembers] = useState(() => [...new Set((thread?.memberIds || initialMembers).filter(id => id !== "self"))]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | "agent" | "human">("all");
  const [showUnavailable, setShowUnavailable] = useState(false);
  const unavailableId = useId();
  const [silence, setSilence] = useState(thread?.allowSilence === undefined || thread.allowSilence === null ? "inherit" : thread.allowSilence ? "allow" : "require");
  const [responsePolicies, setPolicies] = useState<Record<string, ResponsePolicy>>(thread?.responsePolicies || {});
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const request = useRef<{ signature: string; clientId: string } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => { searchInput.current?.focus({ preventScroll: true }); }, []);
  const pair = !thread && members.length < 2;
  const directory = contacts.filter(contact => contact.id !== "self").sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.handle.localeCompare(b.handle) || a.id.localeCompare(b.id));
  const query = search.trim().toLocaleLowerCase();
  const matching = directory.filter(contact => (category === "all" || contact.kind === category) && `${contact.name} @${contact.handle} ${contact.providerName || ""} ${contact.sourceName || ""} ${contactSource(contact)}`.toLocaleLowerCase().includes(query));
  const ready = matching.filter(contact => contact.kind === "agent" && contact.availability === "ready");
  const people = matching.filter(contact => contact.kind === "human");
  const unavailable = matching.filter(contact => contact.kind === "agent" && contact.availability !== "ready");
  const toggleMember = (id: string, selected: boolean) => setMembers(current => selected ? current.includes(id) ? current : [...current, id] : current.filter(member => member !== id));
  const count = members.length;
  const selectionHint = thread ? `群内共 ${count + 1} 位，包含你` : count === 0 ? "选一位开始私聊，选多位创建群聊" : count === 1 ? "将与你选择的伙伴开始私聊" : `将创建 ${count + 1} 人群聊，包含你`;
  const renderChoice = (contact: Contact) => <label className="im-picker-contact" key={contact.id} data-selected={members.includes(contact.id)} data-testid={`im-picker-contact-${contact.id}`}>
    <input type="checkbox" checked={members.includes(contact.id)} data-testid={`im-member-${contact.id}`} onChange={event => toggleMember(contact.id, event.target.checked)} />
    <Avatar contact={contact} size="small" />
    <span className="im-picker-contact-copy"><strong>{contact.name}</strong><small title={`${contactSource(contact)} · @${contact.handle}`}>{contactSource(contact)} · @{contact.handle}</small>{contact.availability !== "ready" && <small className="im-picker-status">{availabilityText[contact.availability]}</small>}</span>
  </label>;
  return <Modal title={thread ? "管理群成员" : "选择聊天伙伴"} onClose={onClose} className="im-dialog im-group-dialog">
    <form className="im-group-form" data-testid="im-group-editor" aria-busy={busy} onSubmit={async event => {
      event.preventDefault(); if (busy || !members.length || (!pair && !title.trim())) return;
      setBusy(true); setError("");
      try {
        const fields = pair ? { kind: "direct", memberIds: members } : { kind: "group", title, memberIds: members, allowSilence: silence === "inherit" ? null : silence === "allow", ...(thread ? { version: thread.version, responsePolicies: Object.fromEntries(Object.entries(responsePolicies).filter(([id]) => members.includes(id))) } : {}) };
        const signature = JSON.stringify(fields);
        if (request.current?.signature !== signature) request.current = { signature, clientId: key() };
        const saved = await api<Thread>(thread ? `/chats/${thread.id}` : "/chats", { ...fields, clientId: request.current.clientId });
        await onSaved(saved);
      } catch (e) { setError(e instanceof Error ? e.message : "群聊尚未保存"); }
      finally { setBusy(false); }
    }}>
      <fieldset className="im-group-workspace" disabled={busy}>
        <section className="im-picker-directory" aria-label="选择联系人">
          <div className="im-picker-toolbar">
            <label className="im-picker-search"><Search size={18} aria-hidden="true" /><input ref={searchInput} autoFocus type="search" aria-label="搜索联系人" placeholder="搜索姓名、用户名或来源" value={search} onChange={event => { setSearch(event.target.value); if (event.target.value.trim()) setShowUnavailable(true); }} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} data-testid="im-group-search" />{search && <button type="button" aria-label="清空搜索" data-testid="im-group-search-clear" onClick={() => { setSearch(""); searchInput.current?.focus(); }}><X size={15} /></button>}</label>
            <div className="im-picker-filters" role="group" aria-label="联系人类型">{([["all", "全部"], ["agent", "AI 助手"], ["human", "联系人"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={category === value} data-testid={`im-group-filter-${value}`} onClick={() => setCategory(value)}>{label}<span>{directory.filter(contact => value === "all" || contact.kind === value).length}</span></button>)}</div>
          </div>
          <div className="im-picker-results" data-testid="im-group-results">
            {ready.length > 0 && <section><h3>可用助手<span>{ready.length}</span></h3>{ready.map(renderChoice)}</section>}
            {people.length > 0 && <section><h3>联系人<span>{people.length}</span></h3>{people.map(renderChoice)}</section>}
            {unavailable.length > 0 && <section className="im-picker-unavailable"><button type="button" aria-expanded={showUnavailable} aria-controls={unavailableId} data-testid="im-group-unavailable-toggle" onClick={() => setShowUnavailable(current => !current)}><span>暂不可用<span>{unavailable.length}</span></span><ChevronDown size={15} /></button><div id={unavailableId} hidden={!showUnavailable}><p>仍可加入，恢复连接后才能回复。</p>{unavailable.map(renderChoice)}</div></section>}
            {matching.length === 0 && <div className="im-picker-empty" data-testid="im-group-empty"><Search size={25} strokeWidth={1.4} aria-hidden="true" /><strong>{query ? "没有找到匹配的联系人" : "这里还没有联系人"}</strong><p>{query ? "试试姓名、@用户名，或助手来源。" : category === "human" ? "已添加的人类联系人会显示在这里。" : "添加联系人后，就能在这里选择。"}</p>{(query || category !== "all") && <button type="button" data-testid="im-group-reset-filters" onClick={() => { setSearch(""); setCategory("all"); searchInput.current?.focus(); }}>查看全部联系人</button>}</div>}
          </div>
        </section>
        <section className="im-picker-review" aria-label="已选成员">
          {!pair && <div className="im-picker-identity"><GroupAvatarEditor members={groupAvatarMembers(["self", ...members], contacts)} /><label>群名称<input required maxLength={80} placeholder="给这个群起个名字" value={title} onChange={event => setTitle(event.target.value)} data-testid="im-group-name" /></label></div>}
          <div className="im-picker-selection-heading"><h3>已选成员<span data-testid="im-group-selection-count" role="status" aria-live="polite">{count}</span></h3><small>不含你</small></div>
          <div className="im-picker-selected" data-testid="im-group-selected">
            <div className="im-picker-selected-row im-picker-self">{contacts.find(contact => contact.id === "self") ? <Avatar contact={contacts.find(contact => contact.id === "self")} size="small" /> : <span className="im-picker-owner-icon"><Users size={17} /></span>}<span className="im-picker-contact-copy"><strong>你</strong><small>自动加入，无需选择</small></span><Check size={15} aria-hidden="true" /></div>
            {members.map(id => { const contact = contacts.find(person => person.id === id); return <div className="im-picker-selected-row" key={id} data-testid={`im-selected-${id}`}>
              {contact ? <Avatar contact={contact} size="small" /> : <span className="im-picker-owner-icon"><Users size={17} /></span>}
              <span className="im-picker-contact-copy"><strong>{contact?.name || "未找到的联系人"}</strong><small title={contact ? `${contactSource(contact)} · @${contact.handle}` : id}>{contact ? `${contactSource(contact)} · @${contact.handle}` : id}</small>{contact && contact.availability !== "ready" && <small className="im-picker-status">{availabilityText[contact.availability]}</small>}</span>
              {thread && contact && onOpenProfile && <button type="button" className="im-picker-small-button" aria-label={`查看${contact.name} @${contact.handle}的设置`} title="联系人设置" data-testid={`im-member-profile-${id}`} onClick={() => onOpenProfile(contact)}><Settings2 size={15} /></button>}
              <button type="button" className="im-picker-small-button" aria-label={`移除${contact ? `${contact.name} @${contact.handle}` : id}`} title="移除成员" data-testid={`im-member-remove-${id}`} onClick={() => toggleMember(id, false)}><X size={15} /></button>
            </div>; })}
            {count === 0 && <div className="im-picker-start" data-testid="im-pair-hint"><Users size={29} strokeWidth={1.3} aria-hidden="true" /><strong>想和谁一起聊？</strong><p>从联系人列表选一位开始。<br />你的选择会显示在这里。</p></div>}
          </div>
          {!pair && <details className="im-picker-settings"><summary data-testid="im-group-settings-toggle"><Settings2 size={15} />回复方式与群设置<ChevronDown size={15} /></summary><div className="im-picker-settings-body">
            <label>允许静默<select data-testid="im-group-silence" value={silence} onChange={event => setSilence(event.target.value)}><option value="inherit">跟随 IM 设置</option><option value="allow">允许：按角色选择回复、表情或保持安静</option><option value="require">关闭：需要文字或表情回应</option></select></label>
            {thread && members.map(id => { const contact = contacts.find(person => person.id === id); return contact?.kind === "agent" ? <label key={id}><span>{contact.name}<small>{contactSource(contact)} · @{contact.handle}</small></span><select aria-label={`${contact.name} @${contact.handle}的响应策略`} data-testid={`im-policy-${id}`} value={responsePolicies[id] || "auto"} onChange={event => setPolicies(current => ({ ...current, [id]: event.target.value as ResponsePolicy }))}><option value="auto">按角色判断，可保持安静</option><option value="mention">仅提及或回复时</option><option value="always">每条消息</option><option value="manual">暂停回应</option></select></label> : null; })}
            <p>默认由各助手按角色参与；@ 表示明确找它。新成员只收到加入后的内容，已接受的运行保持原身份。人类联系人当前仅保存在本机。</p>
          </div></details>}
        </section>
      </fieldset>
      <footer className="im-picker-footer">
        {error && <p role="alert" className="im-error" data-testid="im-group-error">{error}</p>}
        <p data-testid="im-group-selection-hint">{selectionHint}{!pair && !title.trim() && <span>填写群名称即可{thread ? "保存" : "创建"}</span>}</p>
        <div><button type="button" className="im-secondary" disabled={busy} data-testid="im-group-cancel" onClick={onClose}>取消</button><button className="im-primary" disabled={busy || !count || (!pair && !title.trim())} data-testid="im-group-save">{busy ? "正在保存…" : thread ? "保存更改" : pair ? "开始私聊" : <><Plus size={16} />创建群聊</>}</button></div>
      </footer>
    </form>
  </Modal>;
}
