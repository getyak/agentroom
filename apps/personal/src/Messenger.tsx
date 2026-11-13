import { useConversationRead } from "./use-conversation-read";
import { presenceText } from "./contact-presence";
import { directoryContacts, savedContacts, canStartContactChat } from "./contact-directory.mjs";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Bot, Check, ChevronRight, Copy, FileText, Info, Loader2, MessageCircle, PanelLeft, Paperclip, Plus, RefreshCw, Reply, Search, ShieldCheck, Square, UserRound, Users, WifiOff, X } from "lucide-react";
import { api, key, RequestError } from "./api";
import { desktopBridge } from "./native";
import { DecisionView, Modal, Preferences, Reader } from "./ConversationPanels";
import { WorkspaceWelcome } from "./WorkspaceTools";
import { WorkspaceGuide } from "./WorkspaceGuide";
import { LocalAgentPicker } from "./LocalAgentPicker";
import { AgentCard } from "./AgentCard";
import { AgentOnboarding } from "./AgentOnboarding";
import { AgentProfile } from "./AgentProfile";
import { HostDiscovery } from "./HostDiscovery";
import { CreationCards } from "./CreationCard";
import { ArtifactLibrary, LibraryWelcome } from "./ArtifactLibrary";
import { ArtifactWorkspace } from "./ArtifactWorkspace";
import "./artifacts.css";
import { ConversationTimeline } from "./ConversationTimeline";
import { ConversationDetails } from "./ConversationDetails";
import { ApprovalRow, ApprovalSource } from "./ApprovalSource";
import { DraftAttachments } from "./DraftAttachments";
import { approvalContact, approvalSender } from "./approval-identity";
import { ConversationList, ListToolbar, NavigationRail } from "./MessengerNavigation";
import { emptyDraft, restoreDraft, settleCreatedDraft, type ConversationDraft as Draft } from "./conversation-state";
import { RichText } from "./Markdown";
import { Avatar, availabilityText, ContactEditor, GroupEditor } from "./MessengerDialogs";
import type { Approval, Artifact, Attachment, Bootstrap, Contact, Message, Run, Thread, ThreadSummary, WorkspaceArtifact } from "./types";
import type { PersonalServiceId } from "./desktop-contract";
import "./messenger.css";
import "./messenger-navigation.css";

type Screen = "chats" | "contacts" | "approvals" | "library";
const draftCache = new Map<string, Draft>();
const read = <T,>(name: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(`agentstudio.messenger.${name}`) || "null") ?? fallback; } catch { return fallback; }
};
const write = (name: string, value: unknown) => {
  try { localStorage.setItem(`agentstudio.messenger.${name}`, JSON.stringify(value)); return true; } catch { return false; }
};
const savedDraft = (id: string) => {
  const cached = draftCache.get(id);
  if (cached) return cached;
  let legacy: unknown = null;
  try { legacy = JSON.parse(localStorage.getItem(`agentstudio.personal.draft.${id}`) || "null"); } catch { /* Preserve corrupt backups without breaking navigation. */ }
  const draft = restoreDraft(read(`draft.${id}`, null), legacy, id === "new");
  draftCache.set(id, draft);
  return draft;
};
const selectedId = () => new URL(location.href).searchParams.get("thread") || (location.hash.startsWith("#thr_") ? location.hash.slice(1) : null);
const errorText = (e: unknown) => e instanceof Error ? /fetch|network|timeout/i.test(`${e.name} ${e.message}`) ? "连接中断，内容已保留。重试会核对同一个请求。" : e.message : "暂时无法连接，请重试。";
const time = (value: string) => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const date = (value: string) => new Date(value).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });

function IconButton({ label, children, onClick, testId, disabled }: { label: string; children: ReactNode; onClick: () => void; testId?: string; disabled?: boolean }) {
  return <button className="im-icon" aria-label={label} title={label} onClick={onClick} data-testid={testId} disabled={disabled}>{children}</button>;
}

export function App() {
  useEffect(() => {
    const pause = () => { document.documentElement.dataset.avatarPaused = String(document.hidden); };
    pause(); document.addEventListener("visibilitychange", pause);
    return () => { document.removeEventListener("visibilitychange", pause); delete document.documentElement.dataset.avatarPaused; };
  }, []);
  return <Messenger />;
}

const unresolvedApproval = (decision: { state: string }) => ["pending", "sending", "unknown"].includes(decision.state);

function Messenger() {
  const desktop = desktopBridge();
  const [screen, setScreen] = useState<Screen>(() => new URL(location.href).searchParams.has("artifact") ? "library" : "chats");
  const [data, setData] = useState<Bootstrap | null>(read("bootstrap", null));
  const [contactRecords, setContacts] = useState<Contact[]>(read("contacts", []));
  const [serviceAvatars, setServiceAvatars] = useState<Record<string, PersonalServiceId>>({});
  const [serviceImages, setServiceImages] = useState<Record<string, string>>({});
  const [serviceOpeners, setServiceOpeners] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false), [loading, setLoading] = useState(true);
  const contacts = useMemo(() => contactRecords.map(record => {
    const contact = !connected && record.kind === "agent" ? { ...record, avatarActivity: { state: "attention" as const } } : record;
    const connectionId = contact.binding?.type === "connection" ? contact.binding.connectionId : undefined;
    const service = connectionId ? serviceAvatars[connectionId] : undefined;
    return service && connectionId ? { ...contact, avatarService: service, avatarDataUrl: serviceImages[connectionId] || contact.avatarDataUrl } : contact;
  }), [contactRecords, serviceAvatars, serviceImages, connected]);
  const [library, setLibrary] = useState<WorkspaceArtifact[]>([]);
  const [artifactRevision, setArtifactRevision] = useState<string | null>(() => new URL(location.href).searchParams.get("revision"));
  const [artifactId, setArtifactId] = useState<string | null>(() => new URL(location.href).searchParams.get("artifact"));
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [selected, setSelected] = useState<string | null>(selectedId);
  const currentId = useRef(selected); currentId.current = selected;
  const [thread, setThread] = useState<Thread | null>(null);
  const [draft, setDraftState] = useState<Draft>(() => selected ? savedDraft(selected) : emptyDraft());
  const draftRef = useRef(draft); draftRef.current = draft;
  const [error, setError] = useState(""), [draftWarning, setDraftWarning] = useState(false);
  const [search, setSearch] = useState(""), [filter, setFilter] = useState("all");
  const [mentionIndex, setMentionIndex] = useState(0), [dismissedMention, setDismissedMention] = useState("");
  const [mentionCaretAtEnd, setMentionCaretAtEnd] = useState(true);
  const mentionList = useRef<HTMLDivElement>(null);
  const [contactId, setContactId] = useState<string | null>(null), [approvalId, setApprovalId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(() => Boolean(selectedId() || new URL(location.href).searchParams.get("artifact")));
  const [listHidden, setListHidden] = useState(() => read<unknown>("listHidden", false) === true);
  const [preferences, setPreferences] = useState(false), [newChat, setNewChat] = useState(false);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    const open = (event: Event) => { const threadId = (event as CustomEvent).detail; if (typeof threadId === "string" && /^thr_[A-Za-z0-9_-]+$/.test(threadId)) { setSelected(threadId); setScreen("chats"); setPreferences(false); setMobileDetail(true); } };
    window.addEventListener("agentroom:open-device-request", open);
    return () => window.removeEventListener("agentroom:open-device-request", open);
  }, []);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [localPickerOpen, setLocalPickerOpen] = useState(false);
  const [contactEditor, setContactEditor] = useState<Contact | "new" | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [groupEditor, setGroupEditor] = useState<Thread | "new" | null>(null);
  const [reading, setReading] = useState<Artifact | null>(null), [source, setSource] = useState<Attachment | null>(null);
  const [sending, setSending] = useState(false), [busy, setBusy] = useState("");
  const sendingRef = useRef(false), syncing = useRef(0), threadFetch = useRef(0), mounted = useRef(true);
  const viewEpoch = useRef(0);
  const lastFullRefresh = useRef(0);
  const [newMessages, setNewMessages] = useState(false), [messageLimit, setMessageLimit] = useState(80);
  const timeline = useRef<HTMLDivElement>(null), nearBottom = useRef(true), input = useRef<HTMLTextAreaElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const focusToggle = useRef<HTMLButtonElement>(null);
  const actionRequests = useRef(new Map<string, string>());
  const contact = contacts.find(c => c.id === contactId);
  const profileContact = contacts.find(c => c.id === profileId);
  const directContact = thread?.kind === "direct" ? contacts.find(c => thread.memberIds?.includes(c.id) && c.id !== "self") : undefined;
  const selectedApproval = approvals.find(a => a.id === approvalId) || approvals.find(a => unresolvedApproval(a));
  const selectedApprovalContact = selectedApproval ? approvalContact(selectedApproval, contacts) : undefined;
  const pending = approvals.filter(a => unresolvedApproval(a));
  const toggleList = useCallback(() => {
    if (!window.matchMedia("(min-width: 761px)").matches) return;
    const focusWasInList = document.getElementById("im-list")?.contains(document.activeElement);
    setListHidden(hidden => !hidden);
    if (focusWasInList) requestAnimationFrame(() => focusToggle.current?.focus());
  }, []);
  useEffect(() => { write("listHidden", listHidden); }, [listHidden]);
  const focusControl = <button ref={focusToggle} className="im-icon im-focus-toggle" aria-label={listHidden ? "显示列表" : "收起列表，专注阅读"} title={`${listHidden ? "显示列表" : "收起列表"} (⌘\\)`} aria-expanded={!listHidden} aria-controls="im-list" data-testid="im-focus-toggle" onClick={toggleList}><PanelLeft size={19} /></button>;

  const persistDraft = (id: string, value: Draft) => {
    draftCache.set(id, value);
    if (!write(`draft.${id}`, value)) setDraftWarning(true);
    if (currentId.current === id) { draftRef.current = value; setDraftState(value); }
  };
  const editDraft = (patch: Partial<Draft>) => {
    if (!currentId.current) return;
    persistDraft(currentId.current, { ...draftRef.current, ...patch, revision: draftRef.current.revision + 1 });
  };
  const loadThread = useCallback(async (id: string) => {
    const sequence = ++threadFetch.current;
    const result = await api<Thread>(`/threads/${id}`);
    if (mounted.current && currentId.current === id && sequence === threadFetch.current) {
      setThread(result); write(`thread.${id}`, result); setConnected(true);
      setData(current => current ? { ...current, threads: current.threads.map(item => item.id === id ? { ...item, status: result.status, updatedAt: result.updatedAt, unreadCount: result.unreadCount ?? item.unreadCount, lastMessage: result.messages.at(-1) ? { text: result.messages.at(-1)!.text, contactId: result.messages.at(-1)!.contactId } : null } : item) } : current);
    }
    return result;
  }, []);
  const didRead = useCallback((id: string, unreadCount: number) => {
    setData(current => current ? { ...current, threads: current.threads.map(item => item.id === id ? { ...item, unreadCount } : item) } : current);
  }, []);
  useConversationRead(thread, screen === "chats" && selected === thread?.id && !preferences && !newChat && !details && !reading && !source && !onboardingOpen && !discoveryOpen && !contactEditor && !profileId && !groupEditor, timeline, didRead, messageLimit);
  const refresh = useCallback(async () => {
    lastFullRefresh.current = Date.now();
    const sequence = ++syncing.current;
    // Decorative provider identity must never hold up conversations or approvals.
    void desktop?.nativeIntegration?.({ kind: "services" }).then(catalog => {
      if (!mounted.current || sequence !== syncing.current || catalog.state !== "catalog") return;
      setServiceAvatars(Object.fromEntries((catalog.instances || []).flatMap(instance => instance.connectionId && instance.service ? [[instance.connectionId, instance.service]] : [])));
      setServiceImages(Object.fromEntries((catalog.instances || []).flatMap(instance => instance.connectionId && instance.avatarDataUrl ? [[instance.connectionId, instance.avatarDataUrl]] : [])));
      setServiceOpeners(Object.fromEntries((catalog.instances || []).flatMap(instance => instance.connectionId && (instance.id || instance.instanceId) && instance.canOpen ? [[instance.connectionId, (instance.id || instance.instanceId)!]] : [])));
    }).catch(() => { /* Keep the last known icons; core refresh works independently. */ });
    const results = await Promise.allSettled([api<Bootstrap>("/bootstrap"), api<{ contacts: Contact[] }>("/contacts"), api<{ approvals: Approval[] }>("/approvals"), api<{ artifacts: WorkspaceArtifact[] }>("/library/artifacts")]);
    if (!mounted.current || sequence !== syncing.current) return;
    if (results[0].status === "fulfilled") { setData(results[0].value); write("bootstrap", results[0].value); setConnected(true); }
    else { setConnected(false); setError(errorText(results[0].reason)); }
    if (results[1].status === "fulfilled") { setContacts(results[1].value.contacts); write("contacts", results[1].value.contacts); }
    else setError(errorText(results[1].reason));
    if (results[2].status === "fulfilled") setApprovals(results[2].value.approvals);
    else setError(errorText(results[2].reason));
    if (results[3].status === "fulfilled") setLibrary(results[3].value.artifacts);
    setLoading(false);
    if (currentId.current && currentId.current !== "new") await loadThread(currentId.current);
  }, [desktop, loadThread]);
  const refreshSafely = useCallback(() => void refresh().catch(e => { if (mounted.current) { setConnected(false); setError(errorText(e)); } }), [refresh]);
  const openThread = useCallback((id: string, push = true) => {
    viewEpoch.current += 1;
    currentId.current = id; setSelected(id); setScreen("chats"); setMobileDetail(true);
    if (screen !== "chats") { setFilter("all"); setSearch(""); }
    setThread(read(`thread.${id}`, null)); setDraftState(savedDraft(id));
    draftRef.current = savedDraft(id); setError(""); setReading(null); setDetails(false); setMessageLimit(80); nearBottom.current = true; setNewMessages(false);
    if (push) { const url = new URL(location.href); url.hash = ""; url.searchParams.delete("workspace"); url.searchParams.delete("artifact"); url.searchParams.delete("revision"); url.searchParams.set("thread", id); history.pushState(null, "", url); }
    if (id !== "new") void loadThread(id).catch(e => { if (currentId.current === id) setError(errorText(e)); });
  }, [loadThread, screen]);

  useEffect(() => {
    const guide = data?.workspace?.guide;
    if (connected && guide && data.workspace?.onboardingCompleted === false && !currentId.current && screen === "chats" && !new URL(location.href).searchParams.has("artifact")) {
      openThread(guide.threadId, false);
      const url = new URL(location.href); url.searchParams.set("thread", guide.threadId); history.replaceState(null, "", url);
    }
  }, [connected, data, openThread, screen, selected]);

  const openArtifact = (id: string, revisionId?: string) => {
    setArtifactRevision(revisionId || null); setArtifactId(id); setScreen("library"); setMobileDetail(true); setError("");
    const url = new URL(location.href); url.hash = ""; url.searchParams.delete("thread"); url.searchParams.set("artifact", id); if (revisionId) url.searchParams.set("revision", revisionId); else url.searchParams.delete("revision"); history.pushState(null, "", url);
  };

  useEffect(() => {
    mounted.current = true; refreshSafely();
    const url = new URL(location.href);
    if (url.searchParams.has("workspace")) { url.searchParams.delete("workspace"); history.replaceState(null, "", url); }
    let timer: ReturnType<typeof setTimeout> | undefined, fullTimer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => { if (timer) return; timer = setTimeout(() => { timer = undefined; const id = currentId.current; if (id && id !== "new" && Date.now() - lastFullRefresh.current < 1000) { void loadThread(id).catch(e => setError(errorText(e))); if (!fullTimer) fullTimer = setTimeout(() => { fullTimer = undefined; refreshSafely(); }, Math.max(20, 1000 - (Date.now() - lastFullRefresh.current))); } else { clearTimeout(fullTimer); fullTimer = undefined; refreshSafely(); } }, 80); };
    const unsubscribe = desktop?.onChanged(invalidate);
    const events = desktop ? null : new EventSource("/api/events");
    if (events) { events.addEventListener("invalidation", invalidate); events.onopen = invalidate; events.onerror = () => setConnected(false); }
    const interval = desktop ? setInterval(invalidate, 10000) : undefined;
    const visible = () => { if (!document.hidden) invalidate(); };
    document.addEventListener("visibilitychange", visible); window.addEventListener("online", invalidate);
    const offline = () => setConnected(false); window.addEventListener("offline", offline);
    return () => { mounted.current = false; clearTimeout(timer); clearTimeout(fullTimer); clearInterval(interval); events?.close(); unsubscribe?.(); document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", invalidate); window.removeEventListener("offline", offline); };
  }, [desktop, refreshSafely, loadThread]);
  useEffect(() => {
    const navigate = () => { const artifact = new URL(location.href).searchParams.get("artifact"); if (artifact) { setArtifactRevision(new URL(location.href).searchParams.get("revision")); setArtifactId(artifact); setScreen("library"); setMobileDetail(true); return; } const id = selectedId(); if (id) openThread(id, false); else { viewEpoch.current += 1; currentId.current = null; setSelected(null); setThread(null); setMobileDetail(false); } };
    window.addEventListener("popstate", navigate); return () => window.removeEventListener("popstate", navigate);
  }, [openThread]);
  useEffect(() => {
    const command = (value: string) => {
      if (document.querySelector("dialog[open]")) return;
      if (value === "new") setNewChat(true);
      if (value === "search") { setListHidden(false); setMobileDetail(false); requestAnimationFrame(() => searchInput.current?.focus()); }
      if (value === "sidebar") toggleList();
      if (value === "settings") setPreferences(true);
    };
    const unsubscribe = desktop?.onCommand(command);
    const shortcut = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const value = e.key.toLowerCase() === "k" ? "search" : e.key.toLowerCase() === "n" ? "new" : e.key === "," ? "settings" : e.key === "\\" ? "sidebar" : null;
      if (value) { e.preventDefault(); command(value); }
    };
    window.addEventListener("keydown", shortcut); return () => { unsubscribe?.(); window.removeEventListener("keydown", shortcut); };
  }, [desktop, toggleList]);
  useEffect(() => {
    const node = timeline.current;
    if (!node) return;
    if (nearBottom.current) node.scrollTop = node.scrollHeight;
    else setNewMessages(true);
  }, [thread?.id, thread?.messages.length, thread?.runs.map(r => `${r.status}:${r.progress?.updatedAt || ""}`).join(","), screen, mobileDetail]);
  useEffect(() => { const node = input.current; if (node) { node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 160)}px`; } }, [draft.text, selected]);

  const startChat = async (person: Contact, propagateError = false) => {
    setBusy(person.id); setError("");
    try {
      if (!canStartContactChat(person)) throw new Error(availabilityText[person.availability] || "这位助手暂时不能聊天");
      const chat = await api<Thread>("/chats", { kind: "direct", memberIds: [person.id], clientId: actionRequests.current.get(`dm:${person.id}`) || (() => { const value = key(); actionRequests.current.set(`dm:${person.id}`, value); return value; })() });
      setNewChat(false); openThread(chat.id); await refresh(); requestAnimationFrame(() => input.current?.focus());
    } catch (e) { if (propagateError) throw e; setError(errorText(e)); } finally { setBusy(""); }
  };
  const send = async () => {
    const id = currentId.current;
    if (!id || sendingRef.current || !connected || (id !== "new" && !thread)) return;
    const snapshot = draftRef.current;
    const sendingView = viewEpoch.current;
    if (snapshot.recoveryError) { setError(snapshot.recoveryError); return; }
    if (!snapshot.pending && !snapshot.text.trim() && !snapshot.attachments.length) return;
    const task = id === "new" || !thread?.kind;
    const request = snapshot.pending || { body: task
      ? { text: snapshot.text, clientId: key(), attachments: snapshot.attachments.map(({ name, text }) => ({ name, text })), mode: snapshot.mode ?? (thread?.runs.at(-1)?.requestedMode || thread?.runs.at(-1)?.mode) ?? "local", connectionId: (snapshot.connectionId ?? thread?.runs.at(-1)?.connectionId) || undefined, memoryIds: data?.memories.map(m => m.id) || [] }
      : { text: snapshot.text, attachments: snapshot.attachments, replyTo: snapshot.replyTo, memoryIds: data?.memories.map(m => m.id) || [], clientId: key() }, revision: snapshot.revision, ...(id === "new" ? { create: true } : {}) };
    persistDraft(id, { ...snapshot, pending: request });
    sendingRef.current = true; setSending(true); setError("");
    try {
      const result = await api<Thread>(request.create ? "/threads" : `/threads/${id}/messages`, request.body);
      const current = currentId.current === id ? draftRef.current : savedDraft(id);
      const remaining = current.revision === request.revision ? { ...emptyDraft(), mode: current.mode || (task ? request.body.mode as Draft["mode"] : undefined), connectionId: current.connectionId || (task ? request.body.connectionId as string : undefined) } : { ...current, pending: undefined };
      if (request.create) {
        const ownsView = currentId.current === id && viewEpoch.current === sendingView;
        const settled = settleCreatedDraft(current, request.revision, savedDraft(result.id), ownsView);
        persistDraft(id, settled.source);
        if (settled.target) persistDraft(result.id, { ...settled.target, mode: settled.target.mode || request.body.mode as Draft["mode"], connectionId: settled.target.connectionId ?? request.body.connectionId as string | undefined });
        if (ownsView) openThread(result.id);
      } else persistDraft(id, remaining);
      if (currentId.current === result.id) { setThread(result); write(`thread.${result.id}`, result); }
      await refresh();
    } catch (e) {
      if (e instanceof RequestError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.code !== "idempotency_conflict") {
        const current = currentId.current === id ? draftRef.current : savedDraft(id);
        persistDraft(id, { ...current, pending: undefined });
      }
      setError(errorText(e));
    }
    finally { sendingRef.current = false; setSending(false); }
  };
  const react = async (message: Message, emoji: string, active: boolean) => {
    if (!thread) return;
    const id = thread.id, signature = `${id}:${message.id}:${emoji}:${active}`;
    const clientId = actionRequests.current.get(signature) || key(); actionRequests.current.set(signature, clientId);
    setBusy(message.id); setError("");
    try { await api<Thread>(`/threads/${id}/reactions`, { messageId: message.id, emoji, active, clientId }); actionRequests.current.delete(signature); await refresh(); }
    catch (error) { setError(errorText(error)); } finally { setBusy(""); }
  };
  const mutateRun = async (run: Run, action: string) => {
    if (action === "connection") { setPreferences(true); return; }
    if (action === "details") { setDetails(true); return; }
    if (!thread) return;
    const id = thread.id; setBusy(run.id); setError("");
    const signature = `${id}:${run.id}:${action}:${run.status}`;
    const clientId = actionRequests.current.get(signature) || key(); actionRequests.current.set(signature, clientId);
    try { await api<Thread>(`/threads/${id}/${action}`, { clientId, runId: run.id }); await refresh(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  };
  const decide = async (decision: Approval | Thread["decisions"][number], choice: string) => {
    const signature = `${decision.id}:${decision.version}:${choice}`, clientId = actionRequests.current.get(signature) || key();
    actionRequests.current.set(signature, clientId); setBusy(decision.id); setError("");
    const command = decision.kind !== "provider_approval" && choice === "revoke" ? { action: "revoke" }
      : decision.kind !== "provider_approval" && choice === "approve_conversation" ? { choice: "approve", grantDuration: "conversation_exact" } : { choice };
    try { await api(`/decisions/${decision.id}`, { ...command, version: decision.version, clientId }); await refresh(); }
    catch (e) { setError(errorText(e)); refreshSafely(); } finally { setBusy(""); }
  };
  const originalAction = (decision: Thread["decisions"][number]) => {
    const instanceId = decision.providerConnectionId ? serviceOpeners[decision.providerConnectionId] : undefined;
    return instanceId && desktop?.nativeIntegration ? () => {
      void desktop.nativeIntegration!({ kind: "open", instanceId }).catch(e => setError(errorText(e)));
    } : undefined;
  };
  const addFiles = async (files: FileList | null) => {
    if (!files || !currentId.current) return;
    const id = currentId.current;
    try {
      const existing = draftRef.current.attachments;
      if (existing.length + files.length > 5) throw new Error("每条消息最多附 5 份文本资料");
      const added = await Promise.all([...files].map(async file => {
        if (file.size > 500000 || !/\.(txt|md|markdown|csv|json|log|ya?ml|js|ts|tsx|jsx|py|html|css|xml)$/i.test(file.name)) throw new Error("请选择 500 KB 以内的文本、Markdown、CSV 或 JSON 文件");
        return { name: file.name, text: await file.text(), size: file.size };
      }));
      const current = currentId.current === id ? draftRef.current : savedDraft(id);
      if ([...current.attachments, ...added].reduce((size, a) => size + (a.size || new TextEncoder().encode(a.text).length), 0) > 1000000) throw new Error("所附资料合计最多 1 MB");
      persistDraft(id, { ...current, attachments: [...current.attachments, ...added], revision: current.revision + 1 });
    } catch (e) { setError(errorText(e)); }
  };
  const switchScreen = (value: Screen) => { setScreen(value); setSearch(""); setFilter("all"); setMobileDetail(false); setListHidden(false); setError(""); };
  const refreshContacts = async () => { try { await api("/integrations/refresh", {}); await refresh(); } catch (e) { setError(errorText(e)); } };
  const startNotes = () => { setNewChat(false); openThread("new"); requestAnimationFrame(() => input.current?.focus()); };
  const reconnect = async () => { setBusy("reconnect"); setError(""); try { if (desktop) await desktop.restart(); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(""); } };
  const chatTitle = (chat: ThreadSummary) => chat.kind === "direct" ? contacts.find(c => c.id !== "self" && chat.memberIds?.includes(c.id))?.name || chat.title : chat.title;
  const matches = (value: string) => value.toLowerCase().includes(search.toLowerCase());
  const addressBook = savedContacts(contacts);
  const people = directoryContacts(contacts).filter(c => c.id !== "self" && matches(`${c.name} ${c.sourceName || ""} ${c.handle} ${c.description}`) && (filter === "all" || (filter === "agent" ? c.kind === "agent" : c.kind === "human")));
  const shownApprovals = approvals.filter(a => {
    const contact = approvalContact(a, contacts);
    return matches(`${a.title} ${a.threadTitle} ${a.contact?.name || ""} ${contact?.name || ""} ${a.contact?.handle || ""} ${contact?.handle || ""} ${a.source?.label || ""} ${a.source?.name || ""} ${a.source?.botId || ""} ${a.source?.requestText || ""}`) && (filter === "history" ? !unresolvedApproval(a) : unresolvedApproval(a));
  });
  const replyMessage = thread?.messages.find(m => m.id === draft.replyTo);
  const mentionMatch = draft.text.match(/(?:^|\s)@([a-z0-9_-]*)$/i);
  const mentionKey = `${selected}:${draft.text}`;
  const mentionCandidates = thread?.kind === "group" && mentionMatch && mentionMatch.index !== undefined && mentionMatch.index + mentionMatch[0].length === draft.text.length && mentionCaretAtEnd && dismissedMention !== mentionKey ? contacts.filter(c => c.kind === "agent" && thread.memberIds?.includes(c.id) && c.handle.startsWith((mentionMatch[1] || "").toLowerCase())) : [];
  const activeMention = Math.min(mentionIndex, mentionCandidates.length - 1);
  const activeMentionContact = mentionCandidates[activeMention];
  useEffect(() => { setMentionIndex(0); }, [selected, mentionMatch?.[1], mentionCandidates.length]);
  useEffect(() => {
    const list = mentionList.current, option = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [activeMention, mentionCandidates.length]);
  const selectMention = (person: Contact) => { editDraft({ text: draftRef.current.text.replace(/@[a-z0-9_-]*$/i, `@${person.handle} `) }); input.current?.focus(); };
  const composerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (mentionCandidates.length && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((activeMention + (event.key === "ArrowDown" ? 1 : -1) + mentionCandidates.length) % mentionCandidates.length); return; }
      if (event.key === "Enter") { event.preventDefault(); if (activeMentionContact) selectMention(activeMentionContact); return; }
      if (event.key === "Escape") { event.preventDefault(); setDismissedMention(mentionKey); return; }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
  };

  return <div className={`im-app ${desktop ? "im-native" : ""} ${mobileDetail ? "im-show-detail" : ""} ${listHidden ? "im-focused" : ""}`} data-testid="im-app">
    {desktop && <div className="im-window-drag" data-testid="im-window-drag" aria-hidden="true" />}
    <span className="workspace-mode-indicator" data-testid="workspace-mode" data-test-mode={desktop?.testMode || false} hidden={!desktop?.testMode} role="status">测试模式 · 独立资料</span>
    <a className="skip-link" data-testid="im-skip" href="#im-main">跳到聊天内容</a>

    <NavigationRail screen={screen} owner={data?.workspace?.displayName || contacts.find(c => c.id === "self")?.name || "我"} pending={pending.length} unread={(data?.threads || []).reduce((sum, item) => sum + (item.unreadCount || 0), 0)} onScreen={switchScreen} onSettings={() => setPreferences(true)} onRefresh={() => void refreshContacts()} />
    <aside className="im-list-panel" id="im-list" data-testid="im-list-panel" aria-label={screen === "chats" ? "会话列表" : screen === "contacts" ? "联系人列表" : screen === "library" ? "作品列表" : "审批列表"}>
      <ListToolbar screen={screen} search={search} filter={filter} pending={pending.length} inputRef={searchInput} onSearch={setSearch} onFilter={setFilter} onNew={() => screen === "contacts" ? setContactEditor("new") : setNewChat(true)} />
      <div className="im-list-scroll" key={screen} data-testid="im-list-scroll">
        {loading && !data && <p className="im-list-note"><Loader2 size={16} className="working" />正在打开…</p>}
        {screen === "library" && <ArtifactLibrary artifacts={library.filter(item => matches(item.title))} selected={artifactId} query={search} onOpen={openArtifact} onClearSearch={() => { setSearch(""); searchInput.current?.focus(); }} onCreate={() => setGroupEditor("new")} />}
        {screen === "chats" && <ConversationList threads={data?.threads || []} contacts={contacts} search={search} filter={filter} selected={selected} loading={loading} onOpen={openThread} onNew={() => setNewChat(true)} />}
        {screen === "contacts" && people.map(person => <button className={`im-chat-row ${contactId === person.id ? "selected" : ""}`} key={person.id} title={person.sourceName || person.name} data-testid={`im-contact-${person.id}`} onClick={() => { setContactId(person.id); setMobileDetail(true); }} onDoubleClick={() => void startChat(person)}><Avatar contact={person} /><span className="im-row-copy"><strong>{person.name}</strong><small>{person.kind === "agent" ? presenceText(person) || (person.availability === "ready" ? person.description || person.providerName : availabilityText[person.availability]) : "本地联系人"}</small></span><ChevronRight size={16} className="im-muted" /></button>)}
        {screen === "approvals" && shownApprovals.map(item => <ApprovalRow key={item.id} approval={item} contact={approvalContact(item, contacts)} selected={selectedApproval?.id === item.id} onSelect={() => { setApprovalId(item.id); setMobileDetail(true); }} />)}
        {!loading && screen !== "chats" && screen !== "library" && (screen === "contacts" ? people.length === 0 : shownApprovals.length === 0) && <div className="im-list-empty"><span>{search ? "没有找到匹配的内容" : screen === "contacts" ? "还没有这类联系人" : filter === "history" ? "还没有审批记录" : "暂无待处理审批"}</span>{screen === "contacts" && !search && <button onClick={() => setContactEditor("new")}>添加联系人</button>}</div>}
      </div>
      {screen === "contacts" && <button className="im-onboarding-entry" data-testid="im-local-add-entry" onClick={() => setLocalPickerOpen(true)}><Plus size={18} /><span>快速添加本机助手<small>选择常用 Agent，添加后开始聊天</small></span><ChevronRight size={16} /></button>}
      {screen === "contacts" && <button className="im-onboarding-entry" data-testid="im-discovery-entry" onClick={() => setDiscoveryOpen(true)}><Search size={18} /><span>发现本机助手<small>使用已安装或已连接的伙伴</small></span><ChevronRight size={16} /></button>}
      {screen === "contacts" && <button className="im-onboarding-entry" data-testid="im-onboarding-open" onClick={() => setOnboardingOpen(true)}><Bot size={18} /><span>让助手建议角色<small>测试连接，了解已有伙伴和群聊</small></span><ChevronRight size={16} /></button>}
    </aside>
    <main className="im-main" id="im-main" data-testid="im-main">
      {(!connected && !loading) && <div className="im-connection-warning" role="status"><WifiOff size={16} />连接中断，草稿和已加载的消息仍保留。<button disabled={busy === "reconnect"} onClick={() => void reconnect()}>{busy === "reconnect" ? "正在恢复…" : "重新连接"}</button></div>}
      {error && <div className="im-error-banner" role="alert" data-testid="im-error">{error}<IconButton label="关闭提示" onClick={() => setError("")}><X size={16} /></IconButton></div>}
      {screen === "library" && artifactId ? <ArtifactWorkspace key={`${artifactId}:${artifactRevision || "head"}`} artifactId={artifactId} initialRevisionId={artifactRevision || undefined} contacts={contacts} threads={data?.threads || []} toolbar={focusControl} onBack={() => setMobileDetail(false)} onOpenThread={openThread} onChanged={refresh} /> : screen === "contacts" && contact ? <>
        <header className="im-header"><IconButton label="返回联系人" testId="im-back" onClick={() => setMobileDetail(false)}><ArrowLeft size={21} /></IconButton>{focusControl}<strong>联系人信息</strong></header>
        <div className="im-contact-detail" key={contact.id} data-testid="im-contact-detail"><div className="im-contact-summary"><Avatar contact={contact} size="hero" /><div><h2>{contact.name}</h2><span className="im-handle">@{contact.handle}</span><p>{contact.description || (contact.kind === "agent" ? "你的 Agent 伙伴" : "保存在这台 Mac 的联系人")}</p><div className="im-contact-status"><span className={contact.availability === "ready" ? "im-online-dot" : "im-offline-dot"} />{presenceText(contact) || availabilityText[contact.availability]}{contact.presence?.lastSeenAt && contact.presence.state !== "online" && <small>上次在线 {new Date(contact.presence.lastSeenAt).toLocaleString("zh-CN")}</small>}</div></div></div>
          {contact.sourceName && contact.sourceName !== contact.name && <details className="im-contact-source" data-testid="im-contact-source-name"><summary>原服务名称</summary><p>{contact.sourceName}</p></details>}
          <div className="im-profile-actions"><button className="im-primary" onClick={() => void startChat(contact)} disabled={busy === contact.id || !canStartContactChat(contact)} data-testid="im-start-chat"><MessageCircle size={18} />{contact.kind === "human" ? "打开本地对话" : "发送消息"}</button><button className="im-secondary" onClick={() => setContactEditor(contact)} data-testid="im-edit-contact">编辑身份</button>{contact.kind === "agent" && <button className="im-text-button" onClick={() => setProfileId(contact.id)} data-testid="im-agent-profile-open">目标与运行安排<ChevronRight size={15} /></button>}</div>
          {contact.kind === "agent" && <AgentCard contact={contact} />}
          {contact.kind === "agent" && <div className="im-profile-info"><h3>身份与回复方式</h3><p>{contact.instructions || "尚未自定义，使用这位助手的默认身份。"}</p><dl><div><dt>使用助手</dt><dd>{contact.providerName}</dd></div><div><dt>接下来使用</dt><dd>{contact.execution?.model || "助手默认模型"}{contact.execution?.thinking ? ` · ${contact.execution.thinking}` : ""}</dd></div><div><dt>私聊</dt><dd>每条消息都回应</dd></div><div><dt>群聊</dt><dd>根据自己的身份和上下文决定是否回复</dd></div></dl><button className="im-text-button" onClick={() => setPreferences(true)}>管理连接<ChevronRight size={15} /></button></div>}
          {contact.kind === "human" && <p className="im-callout">还未接入跨设备消息网络。这里的对话仅保存在这台 Mac，对方收不到消息。</p>}
        </div>
      </> : screen === "approvals" && selectedApproval ? <>
        <header className="im-header"><IconButton label="返回审批列表" testId="im-back" onClick={() => setMobileDetail(false)}><ArrowLeft size={21} /></IconButton>{focusControl}<div className="im-header-copy"><strong>{approvalSender(selectedApproval, selectedApprovalContact).name}</strong><small>{selectedApproval.source?.label || "来源待核对"} · {selectedApproval.threadTitle}</small></div><button className="im-text-button" data-testid="im-approval-open-chat" onClick={() => openThread(selectedApproval.threadId)}>回到原聊天<ChevronRight size={16} /></button></header>
        <div className="im-approval-content"><ApprovalSource approval={selectedApproval} contact={selectedApprovalContact} canOpenContact={contacts.some(contact => contact.id === selectedApprovalContact?.id)} onContact={() => { setContactId(selectedApprovalContact!.id); setScreen("contacts"); setSearch(""); setFilter("all"); setMobileDetail(true); }} onChat={() => openThread(selectedApproval.threadId)} /><DecisionView decision={selectedApproval} onOpenOriginal={originalAction(selectedApproval)} busy={busy === selectedApproval.id} onDecide={choice => void decide(selectedApproval, choice)} /><p className="im-approval-note">决定和回传状态会同步到原聊天，操作结果另行记录。</p></div>
      </> : screen === "chats" && selected ? <>
        <header className="im-header im-conversation-header"><IconButton label="返回聊天列表" testId="im-back" onClick={() => setMobileDetail(false)}><ArrowLeft size={21} /></IconButton>{focusControl}<button className="im-chat-identity" onClick={() => thread?.kind === "group" ? setGroupEditor(thread) : directContact ? setProfileId(directContact.id) : setDetails(true)} data-testid="im-chat-info"><Avatar contact={directContact} group={thread?.kind === "group"} groupAvatar={thread?.groupAvatar} size="small" /><span><strong><span>{selected === "new" ? "整理资料" : thread ? chatTitle(thread) : "正在打开聊天…"}</span><ChevronRight size={12} /></strong><small className="im-header-presence" data-testid="im-header-status">{directContact?.kind === "agent" && directContact.presence ? presenceText(directContact) : directContact?.kind === "agent" && directContact.availability !== "ready" ? availabilityText[directContact.availability] : thread?.kind === "group" ? thread.runs.some(run => ["running", "verifying"].includes(run.status)) ? `${thread.runs.filter(run => ["running", "verifying"].includes(run.status)).length} 位伙伴正在参与` : thread.runs.some(run => run.status === "queued") ? "消息已保存" : "" : thread?.runs.some(run => ["running", "verifying"].includes(run.status)) ? "正在处理" : thread?.runs.some(run => run.status === "queued") ? "等待处理" : ""}</small></span></button><div className="im-header-actions">{thread?.kind === "direct" && <IconButton label="从这段私聊创建群聊" testId="im-promote-group" onClick={() => setGroupEditor("new")}><Users size={19} /></IconButton>}<IconButton label="聊天记录与成果" testId="im-results" onClick={() => setDetails(true)}><Info size={20} /></IconButton></div></header>
        {thread?.decisions.some(d => unresolvedApproval(d)) && <button className="im-pending-bar" data-testid="im-pending-bar" onClick={() => { setApprovalId(thread.decisions.find(d => unresolvedApproval(d))!.id); setScreen("approvals"); }}><ShieldCheck size={17} /><span>{thread.decisions.filter(d => unresolvedApproval(d)).length} 项审批需要你处理</span><ChevronRight size={17} /></button>}
        <div className="im-timeline" ref={timeline} data-testid="im-timeline" onScroll={e => { const node = e.currentTarget; nearBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop < 100; if (nearBottom.current) setNewMessages(false); }}>
          {thread && thread.messages.length === 0 && thread.decisions.length === 0 && <div className="im-conversation-start"><Avatar contact={directContact} group={thread.kind === "group"} groupAvatar={thread.groupAvatar} size="large" /><h2>{thread.kind === "group" ? "伙伴到齐，开始聊吧。" : `和 ${directContact?.name || thread.title} 聊聊`}</h2><p>{thread.kind === "group" ? "成员会结合自己的角色选择回应；也可以 @ 指定一位伙伴。" : directContact?.instructions || directContact?.description || "发一条消息，开始这段对话。"}</p></div>}
          {thread && <ConversationTimeline thread={{ ...thread, decisions: thread.decisions.map(decision => ({ ...approvals.find(approval => approval.id === decision.id && approval.threadId === thread.id), ...decision })), runs: thread.runs.filter(run => !run.collaboration) }} contacts={contacts} serviceAvatars={serviceAvatars} serviceImages={serviceImages} onDecide={(decision, choice) => void decide(decision, choice)} originalAction={originalAction} limit={messageLimit} onMore={() => setMessageLimit(value => value + 80)} onReply={message => { editDraft({ replyTo: message.id }); input.current?.focus(); }} onContact={id => { setContactId(id); setScreen("contacts"); setMobileDetail(true); }} onSource={setSource} onRun={(run, action) => void mutateRun(run, action)} onReaction={(message, emoji, active) => void react(message, emoji, active)} onError={setError} busy={busy} />}
          {directContact?.systemRole === "guide" && data && <WorkspaceGuide data={data} onDiscover={() => setDiscoveryOpen(true)} onLocal={() => setLocalPickerOpen(true)} onConnect={() => setPreferences(true)} onRoles={() => setOnboardingOpen(true)} onRefresh={refresh} />}
          {thread && <CreationCards state={thread.creation} contacts={contacts} refresh={refresh} onOpen={openArtifact} onError={setError} />}

        </div>
        {newMessages && <button className="im-new-messages" onClick={() => { if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight; nearBottom.current = true; setNewMessages(false); }}><ArrowDown size={16} />回到最新</button>}
        <div className="im-composer-area">
          <>
          {replyMessage && <div className="im-composer-reply"><Reply size={17} /><span><strong>回复 {replyMessage.role === "user" ? "你" : replyMessage.contactSnapshot?.name || "助手"}</strong><small>{replyMessage.text.slice(0, 90)}</small></span><IconButton label="取消回复" onClick={() => editDraft({ replyTo: undefined })}><X size={16} /></IconButton></div>}
          {draft.attachments.length > 0 && <DraftAttachments attachments={draft.attachments} onPreview={setSource} onRemove={index => { input.current?.focus(); editDraft({ attachments: draft.attachments.filter((_, item) => item !== index) }); }} />}
          {draft.pending && !sending && <div className="im-send-recovery" data-testid="im-send-recovery" role="status">上次发送尚未确认，点发送会重试原消息；新写的内容会保留。</div>}
          {mentionCandidates.length > 0 && <div ref={mentionList} className="im-mentions" id="im-mention-list" data-testid="im-mention-list" role="listbox" aria-label="选择要提及的 Agent">{mentionCandidates.map((c, index) => <button type="button" role="option" tabIndex={-1} aria-selected={index === activeMention} id={`im-mention-option-${c.id}`} key={c.id} data-testid={`im-mention-${c.id}`} onMouseEnter={() => setMentionIndex(index)} onClick={() => selectMention(c)}><Avatar contact={c} size="small" /><span>{c.name}<small>@{c.handle}</small></span></button>)}<p className="im-mention-hint" aria-hidden="true">↑↓ 选择 · Enter 采用 · Esc 收起</p></div>}
          <form className="im-composer" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void addFiles(e.dataTransfer.files); }} onSubmit={e => { e.preventDefault(); void send(); }} data-testid="im-composer"><label className="im-icon im-file-button" title="添加文本资料"><Paperclip size={22} /><input type="file" multiple accept=".txt,.md,.markdown,.csv,.json,.log,.yaml,.yml,.js,.ts,.tsx,.jsx,.py,.html,.css,.xml" aria-label="添加文本资料" data-testid="im-attach" onChange={e => { void addFiles(e.target.files); e.target.value = ""; }} /></label><textarea ref={input} rows={1} maxLength={30000} value={draft.text} onChange={e => { setMentionCaretAtEnd(e.target.selectionStart === e.target.value.length && e.target.selectionEnd === e.target.value.length); editDraft({ text: e.target.value }); }} onSelect={e => setMentionCaretAtEnd(e.currentTarget.selectionStart === e.currentTarget.value.length && e.currentTarget.selectionEnd === e.currentTarget.value.length)} onKeyDown={composerKeyDown} aria-autocomplete={thread?.kind === "group" ? "list" : undefined} aria-controls={mentionCandidates.length ? "im-mention-list" : undefined} aria-activedescendant={activeMentionContact ? `im-mention-option-${activeMentionContact.id}` : undefined} aria-label="消息" placeholder={thread?.kind === "group" ? "发送消息，@ 提及 Agent" : directContact?.kind === "human" ? "仅保存在本机…" : "发送消息…"} data-testid="im-message-input" /><button className="im-send" type="submit" aria-label={draft.pending ? "重试发送原消息" : "发送消息"} data-testid="im-send" disabled={sending || !connected || Boolean(draft.recoveryError) || (selected !== "new" && !thread) || (!draft.pending && !draft.text.trim() && !draft.attachments.length)}>{sending ? <Loader2 size={21} className="working" /> : <ArrowUp size={23} />}</button></form>
          {(selected === "new" || (thread && !thread.kind)) && <details className="im-send-options"><summary data-testid="im-send-options-toggle">{(draft.mode || (thread?.runs.at(-1)?.requestedMode || thread?.runs.at(-1)?.mode) || "local") === "local" ? "本地整理" : (draft.mode || (thread?.runs.at(-1)?.requestedMode || thread?.runs.at(-1)?.mode)) === "connection" ? data?.connections.find(c => c.id === (draft.connectionId ?? thread?.runs.at(-1)?.connectionId))?.name || "原连接已移除" : "本机助手"}<ChevronRight size={13} /></summary><div><label>发送方式<select data-testid="im-task-mode" value={draft.mode || (thread?.runs.at(-1)?.requestedMode || thread?.runs.at(-1)?.mode) || "local"} onChange={e => editDraft({ mode: e.target.value as Draft["mode"], connectionId: e.target.value === "connection" ? draft.connectionId ?? thread?.runs.at(-1)?.connectionId ?? "" : "" })}><option value="local">本地整理资料</option><option value="codex">本机助手</option><option value="connection">已连接服务</option></select></label>{(draft.mode || (thread?.runs.at(-1)?.requestedMode || thread?.runs.at(-1)?.mode)) === "connection" && <label>选择连接<select data-testid="im-task-connection" value={draft.connectionId ?? thread?.runs.at(-1)?.connectionId ?? ""} onChange={e => editDraft({ connectionId: e.target.value })}><option value="">请选择原连接</option>{data?.connections.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}{Boolean(draft.connectionId) && !data?.connections.some(c => c.id === draft.connectionId) && <option value={draft.connectionId}>原连接已移除</option>}</select></label>}</div></details>}
          {draft.recoveryError && <p className="im-error" role="alert">{draft.recoveryError}</p>}
          {draftWarning && <p className="im-error" role="alert">本机草稿存储已满，当前内容仅保留在此窗口，请先复制保存。</p>}
          {directContact?.kind === "human" && <p className="im-composer-hint">仅本机保存 · 尚无网络投递</p>}
          </>
        </div>
      </> : screen === "library" ? <LibraryWelcome hasArtifacts={library.length > 0} toolbar={focusControl} onCreate={() => setGroupEditor("new")} /> : <div className="im-welcome"><div className="im-welcome-toolbar">{focusControl}</div>{screen === "chats" && data?.workspace?.onboardingCompleted === false ? <WorkspaceWelcome data={data} contacts={addressBook} onStartContact={async contact => { await refresh(); await startChat(contact); }} onContinue={async next => { await refresh(); if (next === "local") setLocalPickerOpen(true); else if (next === "agents") setOnboardingOpen(true); else if (next === "connect") setPreferences(true); else setNewChat(true); }} /> : <><div className="im-welcome-symbol">{screen === "approvals" ? <ShieldCheck size={37} strokeWidth={1.3} /> : screen === "contacts" ? <Users size={37} strokeWidth={1.3} /> : <MessageCircle size={39} strokeWidth={1.3} />}</div><h2>{screen === "approvals" ? "需要你的时候，都在这里。" : screen === "contacts" ? "认识你的下一位伙伴。" : "好想法，从一句话开始。"}</h2><p>{screen === "approvals" ? "Agent 请求发送内容或调用工具时，可以在这里统一查看和决定。" : screen === "contacts" ? "人和 Agent，都可以成为联系人。为同一个助手创建不同身份，也各有一段对话。" : "和你的 Agent 私聊，或让几个伙伴在群里一起想。每段对话，都能接着聊。"}</p>
        {screen !== "approvals" && <><button className="im-primary" data-testid="im-welcome-start" onClick={() => screen === "contacts" ? setContactEditor("new") : setNewChat(true)}><Plus size={17} />{screen === "contacts" ? "添加联系人" : "发起聊天"}</button>{addressBook.some(c => c.kind === "agent" && c.availability === "ready") && <div className="im-ready-contacts"><span>从你的助手开始</span>{addressBook.filter(c => c.kind === "agent" && c.availability === "ready").slice(0, 3).map(c => <button key={c.id} data-testid={`im-quick-${c.id}`} onClick={() => void startChat(c)} disabled={busy === c.id}><Avatar contact={c} size="small" /><span>{c.name}</span><ChevronRight size={14} /></button>)}</div>}</>}</>}
      </div>}
    </main>
    {newChat && <Modal title="发起聊天" className="im-dialog" onClose={() => setNewChat(false)}><div className="im-new-chat"><button className="im-new-action" data-testid="im-new-notes" onClick={startNotes}><span className="im-action-symbol"><FileText size={22} /></span><span>整理资料<small>继续原草稿，或在本机保存一份新资料</small></span><ChevronRight size={17} /></button><button className="im-new-action" data-testid="im-new-group" onClick={() => { setNewChat(false); setGroupEditor("new"); }}><span className="im-action-symbol"><Users size={22} /></span><span>新建群聊<small>和多位联系人一起聊</small></span><ChevronRight size={17} /></button><button className="im-new-action" data-testid="im-new-contact" onClick={() => { setNewChat(false); setContactEditor("new"); }}><span className="im-action-symbol"><Plus size={22} /></span><span>添加联系人<small>创建 Agent 身份，或添加人</small></span><ChevronRight size={17} /></button><button className="im-new-action" data-testid="im-new-onboarding" onClick={() => { setNewChat(false); setOnboardingOpen(true); }}><span className="im-action-symbol"><Bot size={22} /></span><span>让助手建议角色<small>先测试，再结合当前工作区准备建议</small></span><ChevronRight size={17} /></button><h3>选择联系人</h3><div className="im-new-contact-list">{addressBook.filter(c => c.id !== "self").map(c => <button key={c.id} className="im-chat-row" data-testid={`im-start-${c.id}`} onClick={() => void startChat(c)} disabled={busy === c.id}><Avatar contact={c} /><span className="im-row-copy"><strong>{c.name}</strong><small>{availabilityText[c.availability]}</small></span></button>)}</div><button className="im-text-button" onClick={() => { setNewChat(false); setPreferences(true); }}>连接更多助手<ChevronRight size={16} /></button></div></Modal>}
    {localPickerOpen && <Modal title="添加本机助手" className="im-dialog" onClose={() => setLocalPickerOpen(false)}><LocalAgentPicker onAdded={refresh} onOpen={async peer => { await startChat(peer, true); setLocalPickerOpen(false); }} onConnect={() => { setLocalPickerOpen(false); setPreferences(true); }} /></Modal>}
    {discoveryOpen && <Modal title="发现本机助手" className="im-dialog" onClose={() => setDiscoveryOpen(false)}><HostDiscovery onOpenContact={async id => { const peer = contacts.find(item => item.id === id); if (peer) { await startChat(peer); setDiscoveryOpen(false); } }} onPrepareRoles={() => { setDiscoveryOpen(false); setOnboardingOpen(true); }} onConnect={() => { setDiscoveryOpen(false); setPreferences(true); }} /></Modal>}
    {onboardingOpen && <AgentOnboarding contacts={contacts} onClose={() => setOnboardingOpen(false)} onRefresh={refreshContacts} onAdopted={async () => { await refresh(); }} />}
    {groupEditor && <GroupEditor thread={groupEditor === "new" ? undefined : groupEditor} contacts={addressBook} onOpenProfile={person => setProfileId(person.id)} initialMembers={screen === "chats" && thread?.kind === "direct" ? thread.memberIds?.filter(x => x !== "self") : []} onClose={() => setGroupEditor(null)} onSaved={async saved => { setGroupEditor(null); if (currentId.current === saved.id) { setThread(saved); write(`thread.${saved.id}`, saved); } else openThread(saved.id); await refresh(); }} />}
    {profileContact && <AgentProfile key={profileContact.id} contact={profileContact} onClose={() => setProfileId(null)} onEdit={() => setContactEditor(profileContact)} onChanged={refresh} onOpenThread={id => { setProfileId(null); setGroupEditor(null); openThread(id); }} />}
    {contactEditor && <ContactEditor contact={contactEditor === "new" ? undefined : contactEditor} contacts={contacts} onRefresh={refresh} onClose={() => setContactEditor(null)} onSaved={async saved => { setContactEditor(null); await refresh(); if (profileId === saved.id) return; setContactId(saved.id); setScreen("contacts"); setMobileDetail(true); }} />}
    {details && thread && <ConversationDetails thread={thread} connections={data?.connections || []} busy={busy} onClose={() => setDetails(false)} onRead={setReading} onRun={(run, action) => void mutateRun(run, action)} onDecide={(decision, choice) => void decide(decision, choice)} />}
    {preferences && data && <Preferences data={data} onRefresh={refresh} onWelcome={() => { setPreferences(false); currentId.current = null; setSelected(null); setThread(null); setScreen("chats"); setMobileDetail(true); const url = new URL(location.href); url.searchParams.delete("thread"); url.searchParams.delete("artifact"); url.searchParams.delete("revision"); url.hash = ""; history.replaceState(null, "", url); }} onClose={() => { setPreferences(false); refreshSafely(); }} />}
    {reading && <Reader artifact={reading} sources={thread?.messages.flatMap(m => m.attachments || []) || []} onClose={() => setReading(null)} />}
    {source && <Modal title={source.name} className="reader-modal" onClose={() => setSource(null)}><div className="reader-scroll"><RichText text={source.text} reading /></div></Modal>}
  </div>;
}
