import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, Copy, Link2, RefreshCw, Send, UserPlus } from "lucide-react";
import { api, key, RequestError } from "./api";
import "./friends.css";

type Person = { code: string; name: string };
type Relationship = {
  person: Person;
  direction: "incoming" | "outgoing";
  state: "pending" | "accepted" | "declined" | "withdrawn" | "removed";
  source: "code" | "invite";
  version: number;
};
type Invitation = { id: string; expiresAt: string; claims: number };
type FriendsState = { enabled: boolean; profile: Person | null; relationships: Relationship[]; invitation: Invitation | null; origin?: string };
type Invite = { id: string; url: string; expiresAt: string };
type FriendMessage = { id: string; from: string; text: string; createdAt: string };
type Candidate = { person: Person; relationship?: Relationship | null; self?: boolean; token?: string };
type Decision = "accept" | "decline" | "withdraw" | "remove";

const timestamp = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const errorText = (error: unknown) => error instanceof Error ? error.message : "好友服务暂时无法连接";
const act = <T,>(action: string, payload: Record<string, unknown> = {}) => api<T>("/friends", { action, ...payload });
const inviteFromHash = () => new URLSearchParams(location.hash.slice(1)).get("invite") || null;
const isToken = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);

function registrationKey(browser: boolean) {
  if (browser) {
    try {
      const existing = sessionStorage.getItem("agentroom.friends.registration");
      if (existing) return existing;
      const id = key();
      sessionStorage.setItem("agentroom.friends.registration", id);
      return id;
    } catch { /* The current screen can still create a profile. */ }
  }
  return key();
}

function ShareField({ label, value, testId, onCopied }: { label: string; value: string; testId: string; onCopied: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const copy = () => {
    input.current?.focus();
    input.current?.select();
    try {
      if (document.execCommand("copy")) { onCopied("已复制"); return; }
    } catch { /* Some browsers require the Clipboard API. */ }
    if (navigator.clipboard) void navigator.clipboard.writeText(value).then(() => onCopied("已复制"), () => onCopied("已选中文本，可手动复制"));
    else onCopied("已选中文本，可手动复制");
  };
  return <div className="friends-field"><label htmlFor={testId}>{label}</label><div className="friends-row">
    <input ref={input} id={testId} readOnly value={value} data-testid={testId} onFocus={event => event.currentTarget.select()} />
    <button type="button" className="friends-button" onClick={copy} aria-label={`复制${label}`} data-testid={`${testId}-copy`}><Copy size={15} />复制</button>
  </div></div>;
}

function FriendChat({ profile, friend, onBack }: { profile: Person; friend: Person; onBack: () => void }) {
  const [messages, setMessages] = useState<FriendMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<{ clientId: string; text: string } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      const result = await act<{ messages: FriendMessage[] }>("messages", { code: friend.code });
      if (version === generation.current) setMessages(result.messages);
    } catch (error) {
      if (version === generation.current) setError(errorText(error));
    }
  }, [friend.code]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    return () => { window.clearInterval(timer); generation.current++; };
  }, [refresh]);

  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [messages.at(-1)?.id]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    if (!pending.current || pending.current.text !== text) pending.current = { text, clientId: key() };
    setBusy(true);
    setError("");
    try {
      const { message } = await act<{ message: FriendMessage }>("send", { code: friend.code, ...pending.current });
      generation.current++;
      setMessages(current => current.some(item => item.id === message.id) ? current : [...current.slice(-99), message]);
      setDraft(current => current.trim() === text ? "" : current);
      pending.current = null;
      void refresh();
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };

  return <section className="friends-chat" data-testid="friends-chat">
    <header className="friends-row"><button type="button" className="friends-button" onClick={onBack} disabled={busy} data-testid="friends-chat-back"><ArrowLeft size={16} />好友</button>
      <div><strong>{friend.name}</strong><small>{friend.code}</small></div></header>
    <div className="friends-messages" role="log" aria-label="好友消息" ref={list}>
      {messages.length ? messages.map(message => <div className={`friends-message ${message.from === profile.code ? "mine" : ""}`} key={message.id} data-testid="friends-message">
        <span>{message.text}</span><time dateTime={message.createdAt}>{timestamp(message.createdAt)}</time>
      </div>) : <p className="friends-muted">还没有消息。</p>}
    </div>
    {error && <p role="alert" className="friends-error">{error}</p>}
    <form className="friends-row" onSubmit={send}>
      <textarea aria-label="给好友的消息" data-testid="friends-message-input" placeholder="输入消息" rows={2} maxLength={4000} value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="submit" className="friends-button primary" disabled={busy || !draft.trim()} data-testid="friends-send"><Send size={16} />发送</button>
    </form>
  </section>;
}

export function Friends({ browser = false, ownerName = "" }: { browser?: boolean; ownerName?: string }) {
  const [state, setState] = useState<FriendsState | null>(null);
  const [name, setName] = useState(ownerName);
  const [query, setQuery] = useState("");
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [link, setLink] = useState<Invite | null>(null);
  const [selected, setSelected] = useState<Person | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const registration = useRef<string>(null);
  const inviteKey = useRef<string>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      const next = await api<FriendsState>("/friends");
      if (version === generation.current) setState(next);
    } catch (error) {
      if (version === generation.current) setError(errorText(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { window.clearInterval(timer); generation.current++; };
  }, [refresh]);

  useEffect(() => {
    if (!browser) return;
    let active = true;
    const preview = async () => {
      const token = inviteFromHash();
      if (!token) return;
      setError("");
      setCandidate(null);
      try {
        const result = await act<{ person: Person }>("preview", { token });
        if (active && inviteFromHash() === token) setCandidate({ ...result, token });
      } catch (error) {
        if (active && inviteFromHash() === token) setError(errorText(error));
      }
    };
    void preview();
    window.addEventListener("hashchange", preview);
    return () => { active = false; window.removeEventListener("hashchange", preview); };
  }, [browser]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try { await work(); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      const value = query.trim();
      setCandidate(null);
      if (/^https?:\/\//i.test(value)) {
        const url = new URL(value);
        const token = new URLSearchParams(url.hash.slice(1)).get("invite");
        if (url.origin !== (state?.origin || location.origin) || url.pathname !== "/friends" || !token || !isToken(token)) {
          throw new Error("请粘贴同一 AgentRoom 好友服务生成的邀请链接");
        }
        const result = await act<{ person: Person }>("preview", { token });
        setCandidate({ ...result, token });
      } else {
        setCandidate(await act<Candidate>("lookup", { code: value }));
      }
    });
  };

  const register = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      registration.current ||= registrationKey(browser);
      const next = await act<FriendsState>("register", { name, clientId: registration.current });
      generation.current++;
      setState(current => ({ ...next, origin: current?.origin }));
      if (browser) { try { sessionStorage.removeItem("agentroom.friends.registration"); } catch { /* Storage can be disabled. */ } }
    });
  };

  const request = (person: Candidate) => run(async () => {
    const version = state?.relationships.find(item => item.person.code === person.person.code)?.version || person.relationship?.version || 0;
    const response = person.token ? await act<{ relationship: Relationship }>("join", { token: person.token, version })
      : await act<{ relationship: Relationship }>("request", { code: person.person.code, version });
    if (browser && person.token && inviteFromHash() === person.token) history.replaceState(history.state, "", location.pathname + location.search);
    setCandidate({ person: person.person, relationship: response.relationship });
    setQuery("");
    setNotice(response.relationship.state === "accepted" ? "你们已经是好友" :
      response.relationship.direction === "incoming" ? "对方也发过申请，可在收到的申请里接受" : "已发送好友申请，等待对方接受");
    await refresh();
  });

  const respond = (item: Relationship, decision: Decision) => run(async () => {
    await act("respond", { code: item.person.code, version: item.version, decision });
    setNotice({ accept: "已添加好友", decline: "已拒绝申请", withdraw: "已撤回申请", remove: "已移除好友" }[decision]);
    setConfirmRemove(null);
    if (decision === "remove" && selected?.code === item.person.code) setSelected(null);
    await refresh();
  });

  const createLink = (existing?: string) => run(async () => {
    const clientId = existing || (inviteKey.current ||= key());
    let result: { link: Invite };
    try { result = await act("invite", { clientId }); }
    catch (error) {
      if (!existing && error instanceof RequestError && error.code === "friend_state_changed") inviteKey.current = null;
      throw error;
    }
    if (!existing) inviteKey.current = null;
    setLink(result.link);
    await refresh();
  });

  const revoke = (current: Invitation) => run(async () => {
    await act("revoke", { inviteId: current.id });
    setLink(null);
    setNotice("邀请链接已撤销");
    await refresh();
  });

  const accepted = state?.relationships.filter(item => item.state === "accepted") || [];
  const incoming = state?.relationships.filter(item => item.state === "pending" && item.direction === "incoming") || [];
  const outgoing = state?.relationships.filter(item => item.state === "pending" && item.direction === "outgoing") || [];
  const candidateState = candidate && (state?.relationships.find(item => item.person.code === candidate.person.code) || candidate.relationship);
  const activeLink = link && state?.invitation?.id === link.id ? link : null;
  const selectedFriend = selected && accepted.find(item => item.person.code === selected.code);

  return <div className="friends-panel" data-testid="friends-panel">
    {error && <p role="alert" className="friends-error" data-testid="friends-error">{error} <button type="button" className="friends-text" onClick={() => { setError(""); void refresh(); }}>刷新</button></p>}
    {notice && <p role="status" className="friends-notice" data-testid="friends-notice">{notice}</p>}
    {!state && !error && <p role="status" className="friends-muted">正在连接好友服务…</p>}
    {state?.enabled === false && <p className="friends-muted" data-testid="friends-unconfigured">这个工作区尚未连接好友服务。</p>}
    {state?.enabled && !state.profile && <>
      {candidate && <p className="friends-invite-preview" data-testid="friends-invite-preview"><strong>{candidate.person.name}</strong> 邀请你在 AgentRoom 加好友。</p>}
      <form className="friends-card" onSubmit={register}>
        <label className="friends-field">你的显示名称<input value={name} maxLength={64} required onChange={event => setName(event.target.value)} data-testid="friends-name" /></label>
        <button type="submit" className="friends-button primary" disabled={busy || !name.trim()} data-testid="friends-register"><UserPlus size={16} />创建好友名片</button>
      </form>
    </>}
    {state?.profile && (selectedFriend ? <FriendChat key={selectedFriend.person.code} profile={state.profile} friend={selectedFriend.person} onBack={() => setSelected(null)} /> : <>
      <section className="friends-card" aria-label="我的好友名片">
        <header className="friends-row"><strong>{state.profile.name}</strong><button type="button" className="friends-button" aria-label="刷新好友列表" data-testid="friends-refresh" onClick={() => void refresh()}><RefreshCw size={16} /></button></header>
        <ShareField label="我的好友码" value={state.profile.code} testId="friends-my-code" onCopied={setNotice} />
        {activeLink && <ShareField label="邀请链接" value={activeLink.url} testId="friends-invite-url" onCopied={setNotice} />}
        {state.invitation && <small>邀请有效至 {timestamp(state.invitation.expiresAt)} · 已提交 {state.invitation.claims}/20 份申请</small>}
        <div className="friends-actions">
          {state.invitation && !activeLink && <button type="button" className="friends-button" disabled={busy} onClick={() => void createLink(state.invitation!.id)} data-testid="friends-show-invite"><Link2 size={16} />显示邀请链接</button>}
          <button type="button" className={state.invitation ? "friends-text" : "friends-button"} disabled={busy} onClick={() => void createLink()} data-testid="friends-create-invite">{state.invitation ? "更换链接" : "生成邀请链接"}</button>
          {state.invitation && <button type="button" className="friends-text" disabled={busy} onClick={() => void revoke(state.invitation!)} data-testid="friends-revoke-invite">撤销链接</button>}
        </div>
      </section>
      <form className="friends-field" onSubmit={search}>
        <label htmlFor="friend-search">加好友</label>
        <div className="friends-row"><input id="friend-search" value={query} maxLength={500} placeholder="输入好友码或粘贴邀请链接" onChange={event => setQuery(event.target.value)} data-testid="friends-search" />
          <button type="submit" className="friends-button primary" disabled={busy || !query.trim()} data-testid="friends-find">查找</button></div>
      </form>
      {candidate && <div className="friends-row friends-result" data-testid="friends-result">
        <span><strong>{candidate.person.name}</strong><small>{candidate.token ? "邀请你加好友" : candidate.person.code}</small></span>
        {candidate.self || candidate.person.code === state.profile.code ? <small>你的名片</small> :
          candidateState?.state === "accepted" ? <button type="button" className="friends-button" onClick={() => setSelected(candidate.person)}><Check size={16} />打开私聊</button> :
          candidateState?.state === "pending" ? <small>{candidateState.direction === "incoming" ? "在收到的申请里接受" : "等待对方接受"}</small> :
          <button type="button" className="friends-button primary" disabled={busy} onClick={() => void request(candidate)} data-testid="friends-request">发送好友申请</button>}
      </div>}
      {!!incoming.length && <section className="friends-list" aria-label="收到的申请"><h3>收到的申请</h3>{incoming.map(item => <div key={item.person.code} className="friends-row" data-testid={`friends-incoming-${item.person.code}`}>
        <span><strong>{item.person.name}</strong><small>{item.source === "invite" ? "通过你的邀请链接" : item.person.code}</small></span>
        <div className="friends-actions"><button type="button" className="friends-button primary" disabled={busy} onClick={() => void respond(item, "accept")} data-testid={`friends-accept-${item.person.code}`}>接受</button>
          <button type="button" className="friends-text" disabled={busy} onClick={() => void respond(item, "decline")} data-testid={`friends-decline-${item.person.code}`}>拒绝</button></div>
      </div>)}</section>}
      {!!outgoing.length && <section className="friends-list" aria-label="发出的申请"><h3>等待接受</h3>{outgoing.map(item => <div key={item.person.code} className="friends-row">
        <span><strong>{item.person.name}</strong><small>{item.person.code}</small></span>
        <button type="button" className="friends-text" disabled={busy} onClick={() => void respond(item, "withdraw")} data-testid={`friends-withdraw-${item.person.code}`}>撤回</button>
      </div>)}</section>}
      <section className="friends-list" aria-label="好友列表"><h3>好友</h3>
        {accepted.length ? accepted.map(item => <div key={item.person.code} className="friends-row">
          <button type="button" className="friends-person" onClick={() => setSelected(item.person)} data-testid={`friends-open-${item.person.code}`}><strong>{item.person.name}</strong><small>{item.person.code}</small></button>
          {confirmRemove === item.person.code ? <div className="friends-actions"><button type="button" className="friends-text" onClick={() => setConfirmRemove(null)}>取消</button><button type="button" className="friends-button" disabled={busy} onClick={() => void respond(item, "remove")}>确认移除</button></div> :
            <button type="button" className="friends-text" onClick={() => setConfirmRemove(item.person.code)}>移除</button>}
        </div>) : <p className="friends-muted">还没有好友。</p>}
      </section>
    </>)}
  </div>;
}
