import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronRight, Download, Loader2, PackageOpen, RefreshCw } from "lucide-react";
import { api, key, RequestError } from "./api";
import { Avatar } from "./ContactAvatar";
import type { AssistantCatalog, AssistantEntry, AssistantOperation } from "./assistant-management-types";
import type { LocalAgentId } from "./types";
import "./assistant-management.css";

type Action = AssistantOperation["action"];
type InstallRequest = { clientId: string; action: Action; version: string | null; operationId?: string };
// Closing the picker must not turn a lost receipt into a new install request.
const installRequests = new Map<string, InstallRequest>();
// Receipts outlive one picker mount, so a background completion is handled once.
const observedCompletions = new Set<string>();
const active = (operation: AssistantOperation) => operation.state === "queued" || operation.state === "running";
const text = (error: unknown) => error instanceof Error ? error.message : "暂时无法读取助手目录，请稍后重试。";

/** The directory is independent of local discovery: an offline catalog must not block an existing chat. */
export function useAssistantManagement(onInstalled: () => Promise<void>) {
  const [catalog, setCatalog] = useState<AssistantCatalog | null>(null);
  const [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string[]>([]);
  const [uncertain, setUncertain] = useState<string[]>(() => [...installRequests].filter(([, request]) => !request.operationId).map(([id]) => id));
  const alive = useRef(true), sequence = useRef(0), polling = useRef(false);
  const requests = useRef(installRequests);
  const locks = useRef(new Set<string>()), observed = useRef(observedCompletions);
  const installedRef = useRef(onInstalled);
  installedRef.current = onInstalled;

  const accept = useCallback((snapshot: AssistantCatalog) => {
    if (!alive.current) return;
    setCatalog(snapshot);
    const latest = new Map<string, AssistantOperation>();
    let refreshLocal = false;
    for (const operation of [...snapshot.operations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      if (!latest.has(operation.agentId)) latest.set(operation.agentId, operation);
    }
    for (const operation of latest.values()) {
      if (active(operation)) continue;
      const pending = requests.current.get(operation.agentId);
      // A historical result cannot reconcile a newer request whose receipt was lost.
      if (pending && pending.operationId !== operation.id) continue;
      requests.current.delete(operation.agentId);
      setUncertain(previous => previous.filter(id => id !== operation.agentId));
      if (operation.state === "succeeded" && !observed.current.has(operation.id)) {
        observed.current.add(operation.id);
        refreshLocal = true;
      }
    }
    if (refreshLocal) void installedRef.current().catch(() => { /* Local discovery displays its own recoverable error. */ });
  }, []);

  const reload = useCallback(async (refresh = false, quiet = false) => {
    const version = ++sequence.current;
    if (!quiet) { setError(""); if (refresh) setRefreshing(true); else setLoading(true); }
    try {
      const snapshot = await api<AssistantCatalog>(refresh ? "/assistants/refresh" : "/assistants", refresh ? {} : undefined);
      if (!alive.current || version !== sequence.current) return;
      accept(snapshot); setError("");
    } catch (failure) { if (alive.current && version === sequence.current) setError(text(failure)); }
    finally { if (alive.current && !quiet) { setLoading(false); setRefreshing(false); } }
  }, [accept]);

  useEffect(() => {
    alive.current = true; void reload();
    return () => { alive.current = false; sequence.current++; };
  }, [reload]);

  const needsPolling = Boolean(catalog?.operations.some(active) || uncertain.length || (catalog?.source.refreshing && !error));
  useEffect(() => {
    if (!needsPolling || loading || refreshing) return;
    let disposed = false;
    const poll = async () => {
      if (disposed || polling.current || document.hidden) return;
      polling.current = true;
      try { await reload(false, true); } finally { polling.current = false; }
    };
    const timer = setInterval(() => void poll(), 1500);
    const visible = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [needsPolling, reload, loading, refreshing]);

  const request = useCallback(async (entry: AssistantEntry, action: Action) => {
    const existing = requests.current.get(entry.id);
    if (locks.current.has(entry.id) || (!existing && (!entry.installSupported || !entry.latestVersion))) return;
    locks.current.add(entry.id); setSubmitting(previous => [...previous, entry.id]);
    setActionErrors(previous => { const next = { ...previous }; delete next[entry.id]; return next; });
    let pending = existing;
    if (!pending) {
      pending = { clientId: key(), action, version: entry.latestVersion }; requests.current.set(entry.id, pending);
    }
    try {
      const operation = await api<AssistantOperation>("/assistants/install", { agentId: entry.id, action: pending.action, expectedVersion: pending.version, clientId: pending.clientId });
      if (!alive.current) return;
      pending.operationId = operation.id;
      setCatalog(previous => previous ? { ...previous, operations: [operation, ...previous.operations.filter(item => item.id !== operation.id)] } : previous);
      setUncertain(previous => previous.filter(id => id !== entry.id));
      if (!active(operation)) {
        requests.current.delete(entry.id);
        if (operation.state === "succeeded") { observed.current.add(operation.id); await installedRef.current().catch(() => {}); }
      }
      await reload(false, true);
    } catch (failure) {
      if (!alive.current) return;
      const rejected = failure instanceof RequestError && failure.status >= 400 && failure.status < 500 && failure.status !== 408;
      if (rejected) { requests.current.delete(entry.id); setUncertain(previous => previous.filter(id => id !== entry.id)); }
      else setUncertain(previous => previous.includes(entry.id) ? previous : [...previous, entry.id]);
      const message = failure instanceof RequestError && failure.code === "version_changed" ? "目录中的版本已变化，已重新检查，请选择新版本后继续。" : text(failure);
      setActionErrors(previous => ({ ...previous, [entry.id]: rejected ? message : `${message} 安装结果尚未确认，可核对原请求。` }));
      await reload(false, true);
    } finally {
      locks.current.delete(entry.id);
      if (alive.current) setSubmitting(previous => previous.filter(id => id !== entry.id));
    }
  }, [reload]);

  const operationFor = (id: string) => catalog?.operations.filter(operation => operation.agentId === id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const busyFor = (id: string) => submitting.includes(id) || Boolean(catalog?.operations.some(operation => operation.agentId === id && active(operation)));
  return { catalog, loading, refreshing, error, actionErrors, uncertain, reload, request, operationFor, busyFor };
}

export type AssistantManagementState = ReturnType<typeof useAssistantManagement>;

export function AssistantCatalogStatus({ management }: { management: AssistantManagementState }) {
  const { catalog, error, loading, refreshing, reload } = management;
  const checked = catalog?.source.checkedAt;
  const fetching = refreshing || Boolean(catalog?.source.refreshing && !error);
  const date = checked ? new Date(checked) : null;
  const when = date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date) : "";
  return <div className="im-assistant-catalog-status" data-testid="im-assistant-catalog-status">
    <p>{loading && !catalog ? <><Loader2 size={13} className="working" />正在读取助手目录…</> : error ? "目录暂时无法更新，本机助手仍可使用。" : fetching ? <><Loader2 size={13} className="working" />正在检查最新助手目录…</> : catalog?.source.status === "unavailable" ? "暂时没有可用目录，可重新检查。" : catalog?.source.status === "cached" ? `使用已保存的目录${when ? ` · ${when}` : ""}` : `目录每天自动检查${when ? ` · ${when}` : ""}`}</p>
    <button type="button" className="im-text-button" disabled={loading || fetching} onClick={() => void reload(true)} data-testid="im-assistant-catalog-refresh"><RefreshCw size={13} className={fetching ? "working" : ""} />{fetching ? "检查中…" : "更新目录"}</button>
    {(error || catalog?.source.error) && <span className="im-assistant-catalog-error" data-testid="im-assistant-catalog-error">{error || catalog?.source.error}</span>}
  </div>;
}

export function AssistantInstallStatus({ entry, management, compact = false }: { entry: AssistantEntry; management: AssistantManagementState; compact?: boolean }) {
  const operation = management.operationFor(entry.id), pending = management.busyFor(entry.id);
  const error = management.actionErrors[entry.id];
  const failed = operation && (operation.state === "failed" || operation.state === "interrupted");
  const uncertain = management.uncertain.includes(entry.id);
  const action: Action = entry.installed ? "update" : "install";
  return <div className={`im-assistant-install ${compact ? "compact" : ""}`} data-testid={`im-assistant-install-${entry.id}`}>
    {entry.installed && <span className="im-assistant-version">{entry.installedVersion ? `v${entry.installedVersion}` : "版本待检查"}{entry.source && <span> · {entry.source === "managed" ? "AgentRoom 管理" : "本机已有"}</span>}</span>}
    {pending ? <p role="status" className="im-assistant-progress" data-testid={`im-assistant-progress-${entry.id}`}><Loader2 size={13} className="working" />{operation?.progress || "正在准备安装…"}</p>
      : uncertain ? <button type="button" className="im-text-button" data-testid={`im-assistant-retry-${entry.id}`} onClick={() => void management.request(entry, action)}><RefreshCw size={13} />核对原请求</button>
      : failed ? <button type="button" className="im-text-button" disabled={!entry.installSupported || !entry.latestVersion} data-testid={`im-assistant-retry-${entry.id}`} onClick={() => void management.request(entry, action)}><RefreshCw size={13} />重试{operation.action === "update" ? "升级" : "安装"}</button>
      : entry.installed && entry.updateAvailable ? <button type="button" className="im-text-button" disabled={!entry.installSupported || !entry.latestVersion} data-testid={`im-assistant-update-${entry.id}`} onClick={() => void management.request(entry, "update")}>升级至 v{entry.latestVersion}<ArrowUpRight size={12} /></button>
      : !entry.installed && <button type="button" className="im-secondary" disabled={!entry.installSupported || !entry.latestVersion} data-testid={`im-assistant-install-action-${entry.id}`} onClick={() => void management.request(entry, "install")}><Download size={14} />{entry.latestVersion ? `安装 v${entry.latestVersion}` : "暂不可安装"}</button>}
    {(error || failed) && !pending && <p className="im-error" role="alert" data-testid={`im-assistant-error-${entry.id}`}>{error || operation?.error || "安装没有完成，请重试。"}</p>}
  </div>;
}

export function AssistantDetails({ entry }: { entry: AssistantEntry }) {
  return <details className="im-assistant-details"><summary data-testid={`im-assistant-details-${entry.id}`}>版本与来源</summary><dl>
    <div><dt>接入方式</dt><dd>{entry.kind === "acp" ? "ACP 适配器，版本独立于原助手" : "助手原生程序"}</dd></div>
    <div><dt>最新版本</dt><dd>{entry.latestVersion ? `v${entry.latestVersion}` : "尚未获取"}</dd></div>
    {entry.source && <div><dt>安装来源</dt><dd>{entry.source === "managed" ? "AgentRoom 独立安装" : "本机现有安装"}</dd></div>}
    {entry.path && <div><dt>程序位置</dt><dd>{entry.path}</dd></div>}
    {entry.repository && <div><dt>项目来源</dt><dd>{entry.repository}</dd></div>}
  </dl></details>;
}

export function AssistantManagement({ management, query, onLocal, onOpen, blocked = false }: {
  management: AssistantManagementState; query: string; onLocal: () => void;
  onOpen?: (localAgentId: string) => void; blocked?: boolean;
}) {
  const { catalog, loading, error } = management;
  const search = query.trim().toLocaleLowerCase();
  const entries = (catalog?.entries || []).filter(entry => `${entry.name} ${entry.description} ${entry.kind === "acp" ? "ACP 适配器" : "本机助手"}`.toLocaleLowerCase().includes(search));
  return <div className="im-assistant-discovery" data-testid="im-assistant-discovery">
    <div className="im-assistant-discovery-intro"><PackageOpen size={22} strokeWidth={1.5} /><div><strong>把下一位伙伴带进来</strong><p>浏览可用助手，安装后再添加为联系人。目录会持续更新。</p></div></div>
    <AssistantCatalogStatus management={management} />
    {!loading && !(catalog?.source.refreshing && !error) && entries.length === 0 && <div className="im-assistant-empty" data-testid="im-assistant-catalog-empty"><strong>{search ? "没有找到匹配的助手" : error ? "暂时无法读取目录" : "还没有可安装的助手"}</strong><p>{search ? "换一个名称或关键词试试。" : "可以更新目录，或先使用本机已有助手。"}</p><button type="button" className="im-text-button" onClick={onLocal}>查看本机助手<ChevronRight size={14} /></button></div>}
    <div className="im-assistant-catalog-list">{entries.map(entry => <article className="im-assistant-catalog-card" data-testid={`im-assistant-entry-${entry.id}`} key={entry.id}>
      <div className="im-assistant-catalog-heading"><Avatar contact={{ kind: "agent", name: entry.name, color: entry.kind === "acp" ? "teal" : "blue", ...(entry.kind === "native" ? { avatarAgent: entry.localAgentId as LocalAgentId } : {}) }} size="small" /><div><h3>{entry.name}</h3><span>{entry.kind === "acp" ? "ACP 适配器" : "原生助手"}{entry.installed && <> · <Check size={10} />已安装</>}</span></div>{entry.installed && <button type="button" className="im-text-button" disabled={blocked || management.busyFor(entry.id)} onClick={() => onOpen ? onOpen(entry.localAgentId) : onLocal()} data-testid={`im-assistant-open-${entry.id}`}>查看助手<ChevronRight size={14} /></button>}</div>
      <p className="im-assistant-description">{entry.description || "在 AgentRoom 中添加并使用这位助手。"}</p>
      <AssistantInstallStatus entry={entry} management={management} />
      {entry.reason && !management.busyFor(entry.id) && <p className="im-assistant-reason" data-testid={`im-assistant-reason-${entry.id}`}>{entry.reason}</p>}
      <AssistantDetails entry={entry} />
    </article>)}</div>
  </div>;
}
