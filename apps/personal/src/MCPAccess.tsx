import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, key, RequestError } from "./api";

type Access = {
  id: string;
  version: number;
  enabled: boolean;
  contactIds: string[];
  threadContactIds?: Record<string, string[]>;
  threadIds: string[];
  toolNames: string[];
};
type AccessConnection = { id: string; name: string; access: Access };
type Catalog = {
  connections: AccessConnection[];
  contacts: { id: string; name: string; localAgentId: string }[];
  threads: { id: string; title: string; kind: string; memberIds: string[] }[];
};
type Draft = Omit<Access, "threadContactIds"> & { tools: string; threadContactIds: Record<string, string[]> };
const draftFor = (access: Access): Draft => ({ ...access, threadContactIds: access.threadContactIds || {}, tools: access.toolNames.join("\n") });
const errorText = (error: unknown) => error instanceof Error ? error.message : "暂时无法保存，选择已保留。";
const toggle = (values: string[], id: string) => values.includes(id) ? values.filter(value => value !== id) : [...values, id];

function AccessEditor({ connection, catalog, threadId, onSaved }: {
  connection: AccessConnection;
  catalog: Catalog;
  threadId?: string;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFor(connection.access));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const pending = useRef<{ signature: string; clientId: string } | null>(null);
  const savingRef = useRef(false);
  const currentThread = catalog.threads.find(thread => thread.id === threadId);
  const contacts = catalog.contacts.filter(contact => !threadId || currentThread?.memberIds.includes(contact.id));
  const id = connection.id;
  const prefix = `personal-mcp-access-${id}`;
  const versionChanged = dirty && connection.access.version !== draft.version;
  const selectedContacts = threadId
    ? (draft.threadContactIds[threadId] ?? draft.contactIds).filter(id => contacts.some(contact => contact.id === id))
    : draft.contactIds;
  useEffect(() => {
    if (!dirty && !saving && connection.access.version > draft.version) {
      setDraft(draftFor(connection.access)); pending.current = null; setConflict(false);
    }
  }, [connection.access, dirty, saving, draft.version]);
  const update = (patch: Partial<Draft>) => { setDraft(value => ({ ...value, ...patch })); setDirty(true); setNotice(""); };
  const reload = async () => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const latest = await api<Catalog>("/mcp/access");
      const value = latest.connections.find(item => item.id === id);
      if (!value) throw new Error("这个连接已被移除，请刷新连接列表。");
      setDraft(draftFor(value.access)); setDirty(false); setConflict(false); pending.current = null;
      setNotice("已载入最新设置，可以重新选择后保存。");
      await onSaved();
    } catch (error) { setError(errorText(error)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setError(""); setNotice("");
    const input = {
      version: draft.version, enabled: draft.enabled,
      contactIds: draft.contactIds, threadContactIds: draft.threadContactIds, threadIds: draft.threadIds,
      toolNames: [...new Set(draft.tools.split(/[\n,，]/).map(value => value.trim()).filter(Boolean))],
    };
    const signature = JSON.stringify(input);
    if (pending.current?.signature !== signature) pending.current = { signature, clientId: key() };
    try {
      const saved = await api<Access>(`/mcp/access/${encodeURIComponent(id)}`, { ...input, clientId: pending.current.clientId });
      setDraft(draftFor(saved)); setDirty(false); pending.current = null; setConflict(false);
      setNotice("范围已保存；实际调用仍需逐次审批。");
      await onSaved();
    } catch (error) {
      setError(errorText(error));
      if (error instanceof RequestError && error.status === 409) setConflict(true);
    } finally { savingRef.current = false; setSaving(false); }
  };
  const selectedHere = !threadId || draft.threadIds.includes(threadId);
  return <details className="mcp-access-item" data-testid={prefix}>
    <summary data-testid={`${prefix}-toggle`}>
      <strong>{connection.name}</strong>
      <span>{dirty ? "尚未保存" : connection.access.enabled && (!threadId || connection.access.threadIds.includes(threadId)) ? "已开启范围" : "未开启"}</span>
    </summary>
    <form className="mcp-access-form" data-testid={`${prefix}-form`} onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="mcp-access-check">
        <input type="checkbox" data-testid={`${prefix}-enabled`} checked={draft.enabled} disabled={saving} onChange={event => update({ enabled: event.target.checked })} />
        <span>开启此连接的 Agent 访问{threadId && <small>适用于该连接已选中的所有聊天</small>}</span>
      </label>
      {threadId && <label className="mcp-access-check">
        <input type="checkbox" data-testid={`${prefix}-thread-${threadId}`} checked={selectedHere} disabled={saving || !currentThread} onChange={() => update({ threadIds: toggle(draft.threadIds, threadId) })} />
        <span>允许在此聊天使用</span>
      </label>}
      <fieldset disabled={saving}>
        <legend>{threadId ? "本聊天可使用工具的伙伴" : "默认可使用工具的本机 Agent"}</legend>
        {contacts.map(contact => <label className="mcp-access-check" key={contact.id}>
          <input type="checkbox" data-testid={`${prefix}-contact-${contact.id}`} checked={selectedContacts.includes(contact.id)} onChange={() => {
            if (threadId) update({ threadContactIds: { ...draft.threadContactIds, [threadId]: toggle(selectedContacts, contact.id) } });
            else update({ contactIds: toggle(draft.contactIds, contact.id) });
          }} />
          <span>{contact.name}<small>{contact.localAgentId}</small></span>
        </label>)}
        {!contacts.length && <p className="field-help">{threadId ? "此聊天还没有可使用本机 MCP 的 Agent。" : "先添加 Codex、Claude Code 或 Pi 伙伴，再选择访问范围。"}</p>}
      </fieldset>
      {threadId && <div>
        <p className="field-help">{draft.threadContactIds[threadId] ? "此聊天使用独立的伙伴范围，修改不会影响其他聊天。" : "当前沿用连接的默认伙伴；修改后仅应用于此聊天。"}</p>
        <button type="button" className="text-button" data-testid={`${prefix}-use-default-contacts`} disabled={saving || !draft.threadContactIds[threadId]} onClick={() => {
          const overrides = { ...draft.threadContactIds };
          delete overrides[threadId]; update({ threadContactIds: overrides });
        }}>使用连接默认伙伴</button>
      </div>}
      {!threadId && <fieldset disabled={saving}>
        <legend>可以在哪些聊天使用</legend>
        {catalog.threads.map(thread => <label className="mcp-access-check" key={thread.id}>
          <input type="checkbox" data-testid={`${prefix}-thread-${thread.id}`} checked={draft.threadIds.includes(thread.id)} onChange={() => update({ threadIds: toggle(draft.threadIds, thread.id) })} />
          <span>{thread.title || "未命名聊天"}<small>{thread.kind === "group" ? "群聊" : thread.kind === "direct" ? "私聊" : "任务"}</small></span>
        </label>)}
        {!catalog.threads.length && <p className="field-help">开始聊天后可在这里选择。</p>}
      </fieldset>}
      <p className="field-help">只有同时选中的 Agent 和聊天可以发现工具。{!threadId && "聊天详情中单独设置的伙伴范围优先于这里的默认选择；修改默认伙伴会保留这些设置。"}</p>
      <details className="credential-details">
        <summary data-testid={`${prefix}-tools-toggle`}>限制可用工具</summary>
        <label>工具名称（每行一个，留空允许此连接的全部工具）
          <textarea rows={3} maxLength={16000} data-testid={`${prefix}-tools`} disabled={saving} value={draft.tools} onChange={event => update({ tools: event.target.value })} />
        </label>
        {threadId && <p className="field-help">工具限制适用于此连接的所有聊天。</p>}
      </details>
      {versionChanged && <p className="field-help" role="status" data-testid={`${prefix}-version-changed`}>设置已在别处更新，当前草稿已保留。请先载入最新设置后重新选择。</p>}
      {error && <p className="error-text" role="alert" data-testid={`${prefix}-error`}>{error}</p>}
      {notice && <p className="integration-notice" role="status" data-testid={`${prefix}-notice`}>{notice}</p>}
      <div className="form-actions">
        <button type="button" className="text-button" data-testid={`${prefix}-reload`} disabled={saving} onClick={() => void reload()}>{conflict || versionChanged ? "载入最新设置并替换草稿" : "重新载入此项"}</button>
        <button className="integration-button" data-testid={`${prefix}-save`} disabled={saving || conflict || versionChanged || !dirty}>{saving ? "正在保存…" : "保存范围"}</button>
      </div>
      {conflict && <p className="field-help">设置已在别处更改，当前选择仍在。载入最新设置后再保存。</p>}
    </form>
  </details>;
}

export function MCPAccess({ threadId, refreshToken }: { threadId?: string; refreshToken?: unknown }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++epoch.current;
    setLoading(true); setError("");
    try {
      const value = await api<Catalog>("/mcp/access");
      if (epoch.current === version) setCatalog(value);
    } catch (error) { if (epoch.current === version) setError(errorText(error)); }
    finally { if (epoch.current === version) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    return () => { epoch.current++; };
  }, [refresh, refreshToken]);
  return <section className="integration-section mcp-access" data-testid={threadId ? "personal-chat-mcp-access" : "personal-mcp-access"}>
    <div className="integration-section-heading">
      <h3>MCP 访问范围</h3>
      <button className="text-button" type="button" data-testid="personal-mcp-access-refresh" disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} />刷新列表</button>
    </div>
    <p className="integration-intro">为 Codex、Claude Code、Pi 选择工具范围。Grok、Muse、Dots、Cue 和远端 A2A Agent 继续使用原服务的工具。</p>
    {loading && <p role="status" className="integration-loading">正在读取范围…</p>}
    {error && <p role="alert" className="error-text" data-testid="personal-mcp-access-error">{error}</p>}
    {catalog?.connections.map(connection => <AccessEditor key={`${threadId || "all"}:${connection.id}`} connection={connection} catalog={catalog} threadId={threadId} onSaved={refresh} />)}
    {catalog && !catalog.connections.length && <p className="field-help">连接 MCP 服务后，在这里选择哪些伙伴可以在哪些聊天使用。新连接默认关闭访问。</p>}
    {catalog && <p className="field-help">刷新列表会更新已保存的范围并保留未保存的选择；“重新载入此项”会替换该项草稿。</p>}
  </section>;
}
