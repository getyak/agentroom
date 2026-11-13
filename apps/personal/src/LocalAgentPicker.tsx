import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Bot, ChevronRight, Laptop, Loader2, RefreshCw, UserRound } from "lucide-react";
import { api, key } from "./api";
import { Avatar } from "./ContactAvatar";
import { localAgentChoices, type LocalAgentChoice } from "./local-agent-choices.mjs";
import type { Contact, Integrations } from "./types";
import "./local-agent-picker.css";

export function LocalAgentPicker({ onAdded, onOpen, onConnect, onConfigure, onCustomize, recentContactIds = [] }: {
  onAdded: () => Promise<void>; onOpen: (contact: Contact) => Promise<void>; onConnect: () => void;
  onConfigure?: (contact: Contact) => void; onCustomize?: (kind: "agent" | "human") => void; recentContactIds?: readonly string[];
}) {
  const [inventory, setInventory] = useState<Integrations | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState("");
  const [loadError, setLoadError] = useState(""), [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const alive = useRef(true), action = useRef(false), sequence = useRef(0);
  const pending = useRef(new Map<string, string>());
  const load = useCallback(async (force = false) => {
    if (action.current) return;
    const version = ++sequence.current;
    setLoading(true); setLoadError("");
    try {
      const next = await api<Integrations>(force ? "/integrations/refresh" : "/integrations", force ? {} : undefined);
      const people = await api<{ contacts: Contact[] }>("/contacts");
      if (!alive.current || version !== sequence.current) return;
      setInventory(next); setContacts(people.contacts);
    } catch (e) { if (alive.current && version === sequence.current) setLoadError(e instanceof Error ? e.message : "暂时无法检查本机助手"); }
    finally { if (alive.current && version === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; sequence.current++; }; }, [load]);

  const open = async (choice: LocalAgentChoice) => {
    if (action.current || loading || loadError || choice.state !== "ready" || !choice.contact) return;
    action.current = true; setBusy(choice.agent.id); setActionError(null);
    try {
      let saved = choice.contact;
      if (!choice.added) {
        let clientId = pending.current.get(choice.agent.id);
        if (!clientId) { clientId = key(); pending.current.set(choice.agent.id, clientId); }
        const result = await api<{ contacts: Contact[] }>("/contacts/local", { agentIds: [choice.agent.id], clientId });
        const adopted = result.contacts.find(person => person.id === saved.id);
        if (!adopted) throw new Error("尚未确认添加结果，请重新检查后重试。");
        saved = adopted;
        if (!alive.current) return;
        setContacts(previous => previous.map(person => person.id === saved.id ? saved : person));
      }
      if (saved.availability !== "ready" || saved.configurationError) throw new Error("助手配置已变化，请重新检查后继续。");
      await onAdded();
      if (alive.current) await onOpen(saved);
    } catch (e) { if (alive.current) setActionError({ id: choice.agent.id, message: e instanceof Error ? e.message : "暂时无法打开聊天，请重试。" }); }
    finally { action.current = false; if (alive.current) setBusy(""); }
  };
  const choices = localAgentChoices(inventory, contacts, recentContactIds);
  const supported = choices.filter(choice => choice.state !== "unsupported");
  const unsupported = choices.filter(choice => choice.state === "unsupported");
  const blocked = loading || Boolean(loadError) || Boolean(busy);
  return <section className="im-local-picker" data-testid="im-local-picker" aria-busy={loading || Boolean(busy)}>
    <header><div><Laptop size={17} aria-hidden="true" /><h3>本机已有助手</h3></div><button className="im-icon" data-testid="im-local-refresh" aria-label="重新检查本机助手" disabled={loading || Boolean(busy)} onClick={() => void load(true)}><RefreshCw size={16} className={loading ? "working" : ""} /></button></header>
    <p className="im-local-intro">沿用这台 Mac 上已有的助手配置。</p>
    {loading && <p role="status"><Loader2 size={15} className="working" />{inventory ? "正在更新助手状态…" : "正在查找本机助手…"}</p>}
    <div className="im-local-choices">
      {supported.map((choice, index) => {
        const { agent, contact, added, state, status, reason } = choice;
        const name = contact?.name || agent.name;
        const model = contact?.execution?.model || (contact?.configuration?.modelMode === "fixed" ? contact.configuration.model : contact?.profile?.defaults.model || agent.profile?.defaults.model);
        return <article className="im-local-candidate" key={agent.id} data-testid={`im-local-candidate-${agent.id}`}>
          <div className="im-local-candidate-main">
            <Avatar contact={contact || { kind: "agent", name, color: "blue", avatarAgent: agent.id }} />
            <div className="im-local-copy"><div className="im-local-name"><strong>{name}</strong>{reason && <span>{reason}</span>}</div><small>{status}</small>{model && <small className="im-local-model">{model}</small>}</div>
            <button className={state === "ready" && index === 0 && !added ? "im-primary" : "im-secondary"} data-testid={`im-local-action-${agent.id}`} disabled={blocked} onClick={() => state === "ready" ? void open(choice) : contact?.configurationError && onConfigure ? onConfigure(contact) : onConnect()} aria-label={`${state === "ready" ? added ? "打开聊天" : "添加并聊天" : status === "需要登录" ? "去登录" : "检查配置"}：${name}`}>
              {busy === agent.id ? <><Loader2 size={14} className="working" /><span>正在打开…</span></> : <><span>{state === "ready" ? added ? "打开聊天" : "添加并聊天" : status === "需要登录" ? "去登录" : "检查配置"}</span>{state === "ready" ? <ChevronRight size={14} /> : <ArrowUpRight size={14} />}</>}
            </button>
          </div>
          {actionError?.id === agent.id && <p className="im-error" role="alert">{actionError.message}</p>}
        </article>;
      })}
    </div>
    {!loading && inventory && !supported.length && <div className="im-local-empty" data-testid="im-local-empty"><p>{unsupported.length ? "已找到助手，当前版本尚不支持它们聊天。" : "还没有找到本机助手。"}</p><button className="im-primary" disabled={Boolean(busy)} data-testid="im-local-connect-empty" onClick={onConnect}>连接助手<ChevronRight size={14} /></button></div>}
    {unsupported.length > 0 && <details className="im-local-other"><summary data-testid="im-local-other">其他已发现的助手<span>{unsupported.length}</span></summary>{unsupported.map(({ agent, status }) => <div className="im-local-unsupported" data-testid={`im-local-candidate-${agent.id}`} key={agent.id}><Avatar size="small" contact={{ kind: "agent", name: agent.name, color: "blue", avatarAgent: agent.id }} /><span>{agent.name}<small>{status}</small></span></div>)}</details>}
    {loadError && <div className="im-local-load-error"><p className="im-error" role="alert">{loadError}</p><button className="im-text-button" data-testid="im-local-retry" disabled={loading || Boolean(busy)} onClick={() => void load(true)}>重新检查</button></div>}
    <footer>
      {onCustomize && <div className="im-local-secondary"><button data-testid="im-local-customize" disabled={Boolean(busy)} onClick={() => onCustomize("agent")}><Bot size={16} />自定义角色</button><button data-testid="im-local-human" disabled={Boolean(busy)} onClick={() => onCustomize("human")}><UserRound size={16} />添加人类联系人</button></div>}
      <button className="im-text-button" data-testid="im-local-connect" disabled={Boolean(busy)} onClick={onConnect}>连接其他助手<ChevronRight size={14} /></button>
    </footer>
  </section>;
}
