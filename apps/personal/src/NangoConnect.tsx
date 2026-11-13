import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { api, key } from "./api";
import type { Connection } from "./types";

type RenewReceipt = { previousRemoteRevocation?: string; credentialCleanupPending?: boolean };

const errorText = (error: unknown) => error instanceof Error ? error.message : "暂时无法连接，请稍后重试。";

export function NangoConnect({ onConnected }: { onConnected: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("https://api.nango.dev");
  const [apiKey, setApiKey] = useState("");
  const [integrationId, setIntegrationId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [tools, setTools] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Credentials and retry identity exist only in memory, never browser storage.
  const pending = useRef<{ signature: string; clientId: string } | null>(null);
  const busyRef = useRef(false);
  const connect = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    const input = {
      baseUrl: baseUrl.trim(), apiKey,
      integrationId: integrationId.trim(), connectionId: connectionId.trim(),
      toolNames: [...new Set(tools.split(/[\n,，]/).map(value => value.trim()).filter(Boolean))],
    };
    const signature = JSON.stringify(input);
    if (pending.current?.signature !== signature) pending.current = { signature, clientId: key() };
    try {
      await api("/integrations/nango", { ...input, clientId: pending.current.clientId });
      pending.current = null; setApiKey(""); setOpen(false);
      setNotice("Nango 已连接。会话有效期为 1 小时；请在下方选择 Agent 与聊天范围。");
      try { await onConnected(); }
      catch { setNotice("Nango 已连接，但列表暂时未刷新。请重新检查连接列表；无需再次创建会话。"); }
    } catch (error) { setError(errorText(error)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="nango-connect" data-testid="personal-nango">
    <button type="button" className="text-button integration-own-toggle" data-testid="personal-nango-toggle" aria-expanded={open} disabled={busy} onClick={() => { setOpen(!open); setError(""); }}><Plus size={15} />连接 Nango</button>
    {open && <form className="integration-url-form nango-form" data-testid="personal-nango-form" onSubmit={event => { event.preventDefault(); void connect(); }}>
      <p className="field-help">只允许明确指定的一个 Nango 连接。会话有效期 1 小时，过期后需要手动续期。</p>
      <label>Nango API 地址
        <input type="url" required maxLength={2000} data-testid="personal-nango-base-url" disabled={busy} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} />
      </label>
      <label>API key
        <input type="password" autoComplete="new-password" spellCheck={false} required maxLength={8000} data-testid="personal-nango-api-key" disabled={busy} value={apiKey} onChange={event => setApiKey(event.target.value)} />
      </label>
      <p className="field-help">仅保存在这台 Mac 的加密凭据库，用于创建限定范围的会话，不交给 Agent。</p>
      <label>Integration ID
        <input required maxLength={200} autoComplete="off" spellCheck={false} data-testid="personal-nango-integration-id" disabled={busy} value={integrationId} onChange={event => setIntegrationId(event.target.value)} />
      </label>
      <label>Connection ID（Nango 中已有的连接）
        <input required maxLength={200} autoComplete="off" spellCheck={false} data-testid="personal-nango-connection-id" disabled={busy} value={connectionId} onChange={event => setConnectionId(event.target.value)} />
      </label>
      <details className="credential-details">
        <summary data-testid="personal-nango-tools-toggle">限制会话工具</summary>
        <label>工具名称（每行一个，留空允许此连接的全部工具）
          <textarea rows={3} maxLength={16000} data-testid="personal-nango-tools" disabled={busy} value={tools} onChange={event => setTools(event.target.value)} />
        </label>
      </details>
      <p className="field-help">已有 Nango 会话 URL 和令牌也可通过“连接自己的服务”接入。</p>
      <div className="form-actions">
        <button type="button" className="text-button" data-testid="personal-nango-cancel" disabled={busy} onClick={() => { setApiKey(""); pending.current = null; setOpen(false); setError(""); }}>取消</button>
        <button className="integration-button" data-testid="personal-nango-save" disabled={busy}>{busy ? "正在连接…" : "连接 Nango"}</button>
        {error && <button type="button" className="text-button" data-testid="personal-nango-new-attempt" disabled={busy} onClick={event => {
          pending.current = null;
          event.currentTarget.form?.requestSubmit();
        }}>已在 Nango 核对，发起新申请</button>}
      </div>
    </form>}
    {notice && <p className="integration-notice" role="status" data-testid="personal-nango-notice">{notice}</p>}
    {error && <div>
      <p className="error-text" role="alert" data-testid="personal-nango-error">{error}</p>
      <p className="field-help">普通重试会核对原申请。发起新申请可能创建额外会话，请先到 Nango 核对原申请结果。</p>
    </div>}
  </div>;
}

export function NangoSession({ connection, onRenewed }: { connection: Connection; onRenewed: () => Promise<void> }) {
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [receiptWarning, setReceiptWarning] = useState("");
  const clientId = useRef<string | null>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  if (!connection.nango) return null;
  const expiresAt = new Date(connection.nango.expiresAt);
  const validExpiry = Number.isFinite(expiresAt.getTime());
  const expired = !validExpiry || expiresAt.getTime() <= now;
  const renew = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    clientId.current ||= key();
    try {
      const receipt = await api<RenewReceipt>(`/integrations/nango/${encodeURIComponent(connection.id)}/renew`, { clientId: clientId.current });
      if (receipt.previousRemoteRevocation === "unconfirmed") {
        setReceiptWarning("新会话已创建，但旧 Nango 会话的远端撤销尚未确认，可能保持有效至原会话过期。请到 Nango 核对。" + (receipt.credentialCleanupPending ? "本机旧凭据清理也尚未完成。" : ""));
      } else if (receipt.credentialCleanupPending) {
        setReceiptWarning(previous => previous
          ? previous.includes("本机旧凭据") ? previous : `${previous} 本机旧凭据清理也尚未完成。`
          : "新会话已创建，但本机旧凭据清理尚未完成。连接已更新，请稍后重新核对。");
      }
      clientId.current = null;
      setNotice("新会话已创建。原会话的待审批请求需要重新发起。");
      try { await onRenewed(); }
      catch { setNotice("新会话已创建，但列表暂时未刷新。请重新检查连接列表；无需再次续期。"); }
      setNow(Date.now());
    } catch (error) { setError(errorText(error)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="nango-session" data-testid={`personal-nango-session-${connection.id}`}>
    <p className={expired ? "error-text" : "field-help"} data-testid={`personal-nango-expiry-${connection.id}`}>
      {expired ? "Nango 会话已过期，需要手动续期。" : <>Nango 会话有效至 <time dateTime={connection.nango.expiresAt}>{expiresAt.toLocaleString("zh-CN")}</time>，不会自动续期。</>}
    </p>
    <button type="button" className="text-button" data-testid={`personal-nango-renew-${connection.id}`} disabled={busy} onClick={() => void renew()}><RefreshCw size={13} />{busy ? "正在续期…" : "创建新会话"}</button>
    {error && <>
      <p className="error-text" role="alert" data-testid={`personal-nango-renew-error-${connection.id}`}>{error}</p>
      <p className="field-help">普通重试会核对原申请。发起新申请可能创建额外会话，请先到 Nango 核对原续期结果。</p>
      <button type="button" className="text-button" data-testid={`personal-nango-renew-new-attempt-${connection.id}`} disabled={busy} onClick={() => {
        clientId.current = null; void renew();
      }}>已在 Nango 核对，发起新申请</button>
    </>}
    {receiptWarning && <p className="nango-receipt-warning" role="status" data-testid={`personal-nango-renew-receipt-${connection.id}`}>{receiptWarning}</p>}
    {notice && <p className="integration-notice" role="status">{notice}</p>}
  </div>;
}
