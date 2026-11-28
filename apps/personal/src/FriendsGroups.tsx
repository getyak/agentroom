import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Bot, Plus, Send, Users } from "lucide-react";
import { api, key } from "./api";

export type FriendPerson = { code: string; name: string };
export type FriendRoomSummary = { id: string; title: string; owner: string; membership: "joined" | "invited" };
type RoomAgent = { id: string; name: string; owner: string };
type RoomMessage = { id: string; name: string; from: string; text: string; createdAt: string; agentId?: string; jobState?: "queued" | "running" | "finished" | "failed" };
type RoomDetail = { room: FriendRoomSummary; people: FriendPerson[]; agents: RoomAgent[]; messages: RoomMessage[] };
type LocalCodex = { id: string; name: string };

export const friendAction = <T,>(action: string, payload: Record<string, unknown> = {}) => api<T>("/friends", { action, ...payload });
export const friendError = (error: unknown) => error instanceof Error ? error.message : "好友服务暂时无法连接";

export function FriendRooms({ rooms, friends, open, refresh }: {
  rooms: FriendRoomSummary[]; friends: FriendPerson[]; open: (id: string) => void; refresh: () => Promise<unknown>;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<{ fingerprint: string; clientId: string }>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); await refresh(); }
    catch (error) { setError(friendError(error)); }
    finally { setBusy(false); }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    const fingerprint = JSON.stringify([title.trim(), members]);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, clientId: key() };
    const clientId = pending.current.clientId;
    void run(async () => {
      const { room } = await friendAction<{ room: FriendRoomSummary }>("group-create", { title, people: members, clientId });
      pending.current = null;
      setCreating(false); setTitle(""); setMembers([]); open(room.id);
    });
  };
  return <section className="friends-list" aria-label="好友群" data-testid="friends-groups">
    <header className="friends-row"><h3>好友群</h3>
      <button type="button" className="friends-button" disabled={!friends.length || busy} onClick={() => setCreating(!creating)} data-testid="friends-group-new"><Plus size={16} />{creating ? "取消新建" : "新建群聊"}</button></header>
    {creating && <form className="friends-card" onSubmit={create}>
      <label className="friends-field">群名称<input required maxLength={80} value={title} onChange={e => setTitle(e.target.value)} data-testid="friends-group-title" /></label>
      <fieldset className="friends-options"><legend>邀请好友加入</legend>{friends.map(person => <label key={person.code}>
        <input type="checkbox" data-testid={`friends-group-pick-${person.code}`} checked={members.includes(person.code)}
          disabled={!members.includes(person.code) && members.length >= 7} onChange={e => setMembers(current => e.target.checked ? [...current, person.code] : current.filter(code => code !== person.code))} />
        {person.name}
      </label>)}</fieldset>
      <button type="submit" className="friends-button primary" disabled={busy || !title.trim() || !members.length} data-testid="friends-group-create">创建群聊并邀请</button>
    </form>}
    {error && <p className="friends-error" role="alert">{error}</p>}
    {rooms.map(room => <div key={room.id} className="friends-row" data-testid={`friends-group-${room.id}`}>
      {room.membership === "joined" ? <button type="button" className="friends-person" onClick={() => open(room.id)} data-testid={`friends-group-open-${room.id}`}>
        <strong>{room.title}</strong></button> : <>
        <span><strong>{room.title}</strong><small>好友邀请你加入</small></span>
        <div className="friends-actions"><button type="button" className="friends-button primary" disabled={busy} data-testid={`friends-group-join-${room.id}`}
          onClick={() => void run(async () => { await friendAction("group-answer", { groupId: room.id, decision: "join" }); open(room.id); })}>加入</button>
          <button type="button" className="friends-text" disabled={busy} onClick={() => void run(async () => { await friendAction("group-answer", { groupId: room.id, decision: "decline" }); })}>拒绝</button></div>
      </>}
    </div>)}
  </section>;
}

export function FriendRoom({ groupId, revision, refreshCount, profile, browser, localCodex, back, refreshState }: {
  groupId: string; revision?: number; refreshCount: number; profile: FriendPerson; browser: boolean; localCodex: LocalCodex[]; back: () => void; refreshState: () => Promise<unknown>;
}) {
  const [view, setView] = useState<RoomDetail | null>(null);
  const [local, setLocal] = useState("");
  const [bindings, setBindings] = useState<{ contactId: string; agentId: string; pendingRemove: boolean }[]>([]);
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);
  const epoch = useRef(0);
  const pending = useRef<{ text: string; target: string; clientId: string }>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const refresh = useCallback(async () => {
    const turn = ++epoch.current;
    try {
      const room = await friendAction<RoomDetail>("group-view", { groupId });
      if (turn === epoch.current) setView(room);
    } catch (error) { if (turn === epoch.current) setError(friendError(error)); }
  }, [groupId]);
  const refreshBindings = useCallback(async () => {
    if (!browser) setBindings((await api<{ bindings: typeof bindings }>("/friends/group-codex", { groupId, action: "list" })).bindings);
  }, [browser, groupId]);
  useEffect(() => { void refresh(); return () => { epoch.current++; }; }, [refresh, revision, refreshCount]);
  useEffect(() => { void refreshBindings().catch(error => setError(friendError(error))); }, [refreshBindings, revision]);
  useEffect(() => { if (timeline.current && follow.current) timeline.current.scrollTop = timeline.current.scrollHeight; }, [view?.messages.at(-1)?.id]);

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await operation(); }
    catch (error) { setError(friendError(error)); }
    finally { setBusy(false); }
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const destination = view?.agents.some(agent => agent.id === target) ? target : "";
    if (pending.current?.text !== text || pending.current.target !== destination) pending.current = { text, target: destination, clientId: key() };
    const clientId = pending.current.clientId;
    void run(async () => {
      await friendAction("group-send", { groupId, text, clientId, ...(destination && { targetAgentId: destination }) });
      pending.current = null;
      setDraft(current => current.trim() === text ? "" : current);
      follow.current = true;
      await refresh();
    });
  };
  const add = () => void run(async () => {
    await api("/friends/group-codex", { action: "add", groupId, contactId: local });
    setLocal("");
    await Promise.all([refresh(), refreshBindings()]);
  });
  const remove = (agentId: string) => void run(async () => {
    await api("/friends/group-codex", { action: "remove", groupId, agentId });
    if (target === agentId) setTarget("");
    await Promise.all([refresh(), refreshBindings()]);
  });
  const leave = () => void run(async () => {
    await friendAction("group-answer", { groupId, decision: "leave" });
    await refreshState(); back();
  });
  const agentOwners = new Map(view?.people.map(person => [person.code, person.name]));
  const available = localCodex.filter(contact => !bindings.some(binding => binding.contactId === contact.id));
  const resolvedTarget = view?.agents.some(agent => agent.id === target) ? target : "";
  return <section className="friends-chat" data-testid="friends-group-chat">
    <header className="friends-row"><button type="button" className="friends-button" disabled={busy} onClick={back} data-testid="friends-group-back"><ArrowLeft size={16} />好友群</button>
      <strong>{view?.room.title}</strong></header>
    {error && <p className="friends-error" role="alert" data-testid="friends-group-error">{error}</p>}
    {view && <>
      <details className="friends-card" data-testid="friends-group-members">
        <summary data-testid="friends-group-roster-toggle"><Users size={15} /> {view.people.length} 位好友 · {view.agents.length} 位 Agent</summary>
        <p className="friends-muted">{view.people.map(person => person.name).join("、")}</p>
        {view.agents.map(agent => <div className="friends-row" key={agent.id} data-testid={`friends-group-agent-${agent.id}`}>
          <span><Bot size={14} /> {agent.name}<small>{agentOwners.get(agent.owner)} 的本机 Agent</small></span>
          {bindings.some(binding => binding.agentId === agent.id) && <button type="button" className="friends-text" disabled={busy} onClick={() => remove(agent.id)}>{bindings.some(binding => binding.agentId === agent.id && binding.pendingRemove) ? "重试撤销" : "停止共享"}</button>}
        </div>)}
        {!browser && <><label className="friends-field">添加我的 Codex
          <select value={local} data-testid="friends-group-codex-picker" onChange={e => setLocal(e.target.value)}>
            <option value="">{available.length ? "选择已添加的本机联系人" : "先在联系人中添加本机 Codex"}</option>
            {available.map(contact => <option value={contact.id} key={contact.id}>{contact.name}</option>)}
          </select></label>
          {local && <div className="friends-field"><small>加入后，群友可点名调用。Codex 在这台 Mac 上隔离运行，只接收共享后的本群文字。</small>
            <button type="button" className="friends-button primary" data-testid="friends-group-codex-share" disabled={busy} onClick={add}>同意并加入群聊</button></div>}</>}
        <div className="friends-actions">{leaving ? <><button className="friends-text" type="button" onClick={() => setLeaving(false)}>取消</button>
          <button type="button" className="friends-button" disabled={busy} onClick={leave}>确认退出</button></> :
          <button type="button" className="friends-text" onClick={() => setLeaving(true)}>退出该群</button>}</div>
      </details>
      <div role="log" aria-label="好友群消息" className="friends-messages" ref={timeline} onScroll={e => {
        const list = e.currentTarget; follow.current = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
      }}>
        {view.messages.length ? view.messages.map(message => <div className={`friends-message ${message.from === profile.code && !message.agentId ? "mine" : ""}`}
          key={message.id} data-testid="friends-group-message" data-agent-id={message.agentId}>
          <small>{message.name}{message.agentId && " · Agent"}</small><span>{message.text}</span>
          {message.jobState && message.jobState !== "finished" && <small>{({ queued: "等待来源 Mac", running: "Codex 正在回复", failed: "本次调用未完成" })[message.jobState]}</small>}
        </div>) : <p className="friends-muted">还没有消息。</p>}
      </div>
      <form className="friends-field" onSubmit={send}>
        <label className="friends-field">发送给<select value={resolvedTarget} onChange={e => setTarget(e.target.value)} data-testid="friends-group-target">
          <option value="">全体群友</option>{view.agents.map(agent => <option key={agent.id} value={agent.id}>@{agent.name} · {agentOwners.get(agent.owner)}</option>)}
        </select></label>
        <div className="friends-row"><textarea aria-label="发送好友群消息" data-testid="friends-group-input" value={draft} maxLength={4000} rows={2} onChange={e => setDraft(e.target.value)} />
          <button type="submit" className="friends-button primary" data-testid="friends-group-send" disabled={busy || !draft.trim()}><Send size={16} />发送</button></div>
      </form>
    </>}
  </section>;
}
