import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check, FolderOpen, MessageCircle, Pin, PinOff, Plus, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import { Avatar } from "./ContactAvatar";
import { movePin, normalizePins, togglePin } from "./conversation-pins";
import { conversationTime } from "./conversation-time";
import { MarkdownPreview } from "./Markdown";
import type { Contact, ThreadSummary } from "./types";

export type MessengerScreen = "chats" | "contacts" | "approvals" | "library";

function UnreadBadge({ count = 0, testId }: { count?: number; testId: string }) {
  return count > 0 ? <span className="im-unread-badge" data-testid={testId} aria-label={`${count} 条未读消息`}>{count > 99 ? "99+" : count}</span> : null;
}

export function NavigationRail({ screen, owner, pending, unread = 0, onScreen, onSettings, onRefresh }: {
  screen: MessengerScreen; owner: string; pending: number; unread?: number;
  onScreen: (screen: MessengerScreen) => void; onSettings: () => void; onRefresh: () => void;
}) {
  return <nav className="im-rail" aria-label="主导航" data-testid="im-rail">
    <div className="im-rail-drag" />
    <button className="im-owner" aria-label="个人与设置" title={owner || "个人与设置"} data-testid="im-profile" onClick={onSettings}><Avatar contact={{ name: owner || "我", kind: "human", color: "teal" }} /><span className="im-owner-dot" /></button>
    <div className="im-rail-pages">{([["chats", MessageCircle, "聊天"], ["contacts", Users, "联系人"], ["approvals", ShieldCheck, "审批"], ["library", FolderOpen, "作品"]] as const).map(([id, Icon, label]) => <button key={id} className={`im-nav-item ${screen === id ? "selected" : ""}`} aria-label={id === "chats" && unread > 0 ? `${label}，${unread} 条未读消息` : label} title={label} aria-current={screen === id ? "page" : undefined} data-testid={`im-nav-${id}`} onClick={() => onScreen(id)}><span><Icon size={21} strokeWidth={1.7} />{id === "chats" && <UnreadBadge count={unread} testId="im-unread-total" />}{id === "approvals" && pending > 0 && <b>{pending}</b>}</span></button>)}</div>
    <div className="im-rail-bottom"><button className="im-icon" aria-label="刷新联系人和会话" title="刷新联系人和会话" data-testid="im-refresh" onClick={onRefresh}><RefreshCw size={18} /></button><button className="im-icon" aria-label="连接与设置" title="连接与设置" data-testid="im-settings" onClick={onSettings}><Settings2 size={21} strokeWidth={1.7} /></button></div>
  </nav>;
}

export function ListToolbar({ screen, search, filter, pending, inputRef, onSearch, onFilter, onNew }: {
  screen: MessengerScreen; search: string; filter: string; pending: number; inputRef: RefObject<HTMLInputElement | null>;
  onSearch: (value: string) => void; onFilter: (value: string) => void; onNew: () => void;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const options = screen === "chats" ? [["all", "全部会话"], ["unread", "未读消息"], ["group", "群聊"], ["pinned", "已置顶"], ["attention", "待审批"]] : screen === "contacts" ? [["all", "全部联系人"], ["agent", "Agent"], ["human", "人"]] : [["all", `待处理${pending ? ` ${pending}` : ""}`], ["history", "历史"]];
  const activeLabel = options.find(([id]) => id === filter)?.[1];
  useEffect(() => { if (disclosure.current) disclosure.current.open = false; }, [screen]);
  return <div className="im-list-toolbar" data-testid="im-list-toolbar">
    <div className="im-search-group" data-testid="im-search-group">
      <label className="im-search"><Search size={16} aria-hidden="true" /><input type="search" ref={inputRef} value={search} onChange={e => onSearch(e.target.value)} placeholder={screen === "chats" ? "搜索" : screen === "contacts" ? "搜索联系人" : screen === "library" ? "搜索作品" : "搜索审批"} aria-label="搜索" data-testid="im-search" /></label>
      {screen !== "library" && <details className="im-filter" ref={disclosure} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) e.currentTarget.open = false; }} onKeyDown={e => { if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary")?.focus(); } }}>
        <summary aria-label={`筛选：${activeLabel}`} title={`筛选：${activeLabel}`} data-testid="im-filter-toggle"><SlidersHorizontal size={16} />{filter !== "all" && <span className="im-filter-active" />}</summary>
        <div className="im-filter-options" aria-label="列表筛选" data-testid="im-filter-options">{options.map(([id, label]) => <button key={id} aria-pressed={filter === id} data-testid={`im-filter-${id}`} onClick={() => { onFilter(id!); if (disclosure.current) { disclosure.current.open = false; disclosure.current.querySelector("summary")?.focus(); } }}><span>{label}</span>{filter === id && <Check size={15} />}</button>)}</div>
      </details>}
    </div>
    {screen !== "library" && <button className="im-new-button" aria-label={screen === "contacts" ? "添加联系人" : "发起聊天"} title={screen === "contacts" ? "添加联系人" : "发起聊天 (⌘N)"} data-testid="im-new" onClick={onNew}><Plus size={21} strokeWidth={1.7} /></button>}
  </div>;
}

const pinsKey = "agentstudio.messenger.pins";
const readPins = () => { try { return normalizePins(JSON.parse(localStorage.getItem(pinsKey) || "null")); } catch { return []; } };

export function ConversationList({ threads, contacts, search, filter, selected, loading, onOpen, onNew }: {
  threads: ThreadSummary[]; contacts: Contact[]; search: string; filter: string; selected: string | null; loading: boolean;
  onOpen: (id: string) => void; onNew: () => void;
}) {
  const [pins, setPins] = useState(readPins);
  const [saveError, setSaveError] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLElement } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const title = (chat: ThreadSummary) => chat.kind === "direct" ? contacts.find(c => c.id !== "self" && chat.memberIds?.includes(c.id))?.name || chat.title : chat.title;
  const person = (chat: ThreadSummary) => chat.kind === "direct" ? contacts.find(c => c.id !== "self" && chat.memberIds?.includes(c.id)) : undefined;
  const chats = threads.filter(chat => `${title(chat)} ${person(chat)?.sourceName || ""} ${chat.title} ${chat.lastMessage?.text || chat.summary}`.toLowerCase().includes(search.toLowerCase()) && (filter !== "unread" || (chat.unreadCount || 0) > 0) && (filter !== "group" || chat.kind === "group") && (filter !== "pinned" || pins.includes(chat.id)) && (filter !== "attention" || Boolean(chat.pendingApprovals) || chat.status === "needs_input"));
  const pinned = pins.flatMap(id => { const chat = chats.find(chat => chat.id === id); return chat ? [chat] : []; });
  const save = (next: string[]) => {
    setPins(next);
    try { localStorage.setItem(pinsKey, JSON.stringify(next)); setSaveError(false); } catch { setSaveError(true); }
  };
  const restoreFocus = (id: string, trigger: HTMLElement) => requestAnimationFrame(() => {
    const target = trigger.isConnected ? trigger : rows.current.get(id) || document.querySelector<HTMLElement>('[data-testid="im-filter-toggle"]');
    target?.focus();
  });
  const closeMenu = (focus = false) => { if (focus && menu) restoreFocus(menu.id, menu.trigger); setMenu(null); };
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === pinsKey || event.key === null) setPins(readPins()); };
    window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(null); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); menu.trigger.focus(); setMenu(null); } };
    const dismiss = () => setMenu(null);
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    window.addEventListener("resize", dismiss); window.addEventListener("scroll", dismiss, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("resize", dismiss); window.removeEventListener("scroll", dismiss, true); };
  }, [menu]);
  const showMenu = (id: string, trigger: HTMLElement, x: number, y: number) => setMenu({ id, trigger, x: Math.max(8, Math.min(x, innerWidth - 196)), y: Math.max(8, Math.min(y, innerHeight - 148)) });
  return <>
    {pinned.length > 0 && <div className="im-pinned" aria-label="置顶会话" data-testid="im-pinned">{pinned.map(chat => <button key={chat.id} className={`im-pinned-chat ${selected === chat.id ? "selected" : ""}`} aria-label={`打开置顶会话：${title(chat)}${chat.unreadCount ? `，${chat.unreadCount} 条未读消息` : ""}`} title={`${title(chat)} · 右键管理置顶`} aria-current={selected === chat.id ? "true" : undefined} data-testid={`im-pinned-${chat.id}`} onClick={() => onOpen(chat.id)} onContextMenu={e => { e.preventDefault(); showMenu(chat.id, e.currentTarget, e.clientX, e.clientY); }} onKeyDown={e => {
      if (e.altKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); save(movePin(pins, chat.id, e.key === "ArrowLeft" ? -1 : 1)); }
      if (e.key === "F10" && e.shiftKey) { e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); showMenu(chat.id, e.currentTarget, rect.left, rect.bottom); }
    }}><span className="im-pinned-portrait"><Avatar group={chat.kind === "group"} groupAvatar={chat.groupAvatar} contact={person(chat)} /><UnreadBadge count={chat.unreadCount} testId={`im-pinned-unread-${chat.id}`} />{Boolean(chat.pendingApprovals) && <span className="im-pinned-attention" />}</span><span className="im-pinned-name">{title(chat)}</span></button>)}</div>}
    {saveError && <p className="im-list-note" role="status">置顶更改暂未保存，关闭窗口后可能丢失。</p>}
    {chats.map(chat => <div className={`im-chat-item ${selected === chat.id ? "selected" : ""}`} key={chat.id} onContextMenu={e => { e.preventDefault(); const trigger = e.currentTarget.querySelector<HTMLButtonElement>("button")!; showMenu(chat.id, trigger, e.clientX, e.clientY); }}>
      <button ref={node => { if (node) rows.current.set(chat.id, node); else rows.current.delete(chat.id); }} className={`im-chat-row ${selected === chat.id ? "selected" : ""}`} data-testid={`im-chat-${chat.id}`} aria-label={`${title(chat)}${chat.unreadCount ? `，${chat.unreadCount} 条未读消息` : ""}`} aria-current={selected === chat.id ? "true" : undefined} onClick={() => onOpen(chat.id)}><span className="im-chat-portrait"><Avatar group={chat.kind === "group"} groupAvatar={chat.groupAvatar} contact={person(chat)} /><UnreadBadge count={chat.unreadCount} testId={`im-unread-${chat.id}`} /></span><span className="im-row-copy"><span className="im-row-title"><strong>{title(chat)}</strong><time dateTime={chat.updatedAt} title={new Date(chat.updatedAt).toLocaleString("zh-CN")}>{conversationTime(chat.updatedAt)}</time></span><span className="im-row-preview">{chat.status === "needs_input" ? <span className="im-attention">等待你审批</span> : chat.status === "running" ? <span className="im-blue">正在回复…</span> : chat.lastMessage?.text ? <MarkdownPreview text={chat.lastMessage.text} /> : "开始这段聊天"}{Boolean(chat.pendingApprovals) && <b className="im-count">{chat.pendingApprovals}</b>}</span></span></button>
      <button className={`im-row-pin ${pins.includes(chat.id) ? "is-pinned" : ""}`} aria-label={`${pins.includes(chat.id) ? "取消置顶" : "置顶"}：${title(chat)}`} title={pins.includes(chat.id) ? "取消置顶" : "置顶"} aria-pressed={pins.includes(chat.id)} data-testid={`im-pin-${chat.id}`} onClick={e => { const trigger = e.currentTarget; save(togglePin(pins, chat.id)); restoreFocus(chat.id, trigger); }}>{pins.includes(chat.id) ? <PinOff size={14} /> : <Pin size={14} />}</button>
    </div>)}
    {!loading && chats.length === 0 && <div className="im-list-empty"><span>{search ? "没有找到匹配的内容" : filter === "unread" ? "没有未读消息" : filter === "pinned" ? "还没有置顶会话" : filter === "attention" ? "暂无待审批的会话" : filter === "group" ? "还没有群聊" : "还没有聊天"}</span>{filter === "pinned" && !search && <small>在会话右侧点置顶，常聊的伙伴就会出现在这里。</small>}{filter === "all" && !search && <button onClick={onNew}>发起第一段聊天</button>}</div>}
    {menu && createPortal(<div ref={menuRef} className="im-conversation-menu" role="menu" aria-label="管理置顶会话" data-testid="im-conversation-menu" style={{ left: menu.x, top: menu.y }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMenu(null); }} onKeyDown={e => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault(); const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}><button role="menuitem" data-testid="im-menu-pin" onClick={() => { save(togglePin(pins, menu.id)); closeMenu(true); }}>{pins.includes(menu.id) ? <PinOff size={16} /> : <Pin size={16} />}{pins.includes(menu.id) ? "取消置顶" : "置顶会话"}</button>{pins.includes(menu.id) && <><button role="menuitem" data-testid="im-pin-earlier" disabled={pins.indexOf(menu.id) === 0} onClick={() => { save(movePin(pins, menu.id, -1)); closeMenu(true); }}><ArrowLeft size={16} />向前移动</button><button role="menuitem" data-testid="im-pin-later" disabled={pins.indexOf(menu.id) === pins.length - 1} onClick={() => { save(movePin(pins, menu.id, 1)); closeMenu(true); }}><ArrowRight size={16} />向后移动</button></>}</div>, menu.trigger.closest(".im-app") || document.body)}
  </>;
}
