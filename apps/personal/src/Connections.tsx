import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, FileText, Loader2, Plus, RefreshCw, Search, Terminal, Trash2, Unplug, X } from "lucide-react";
import grokIcon from "@agentstudio/brand/assets/grokbot.png";
import museIcon from "@agentstudio/brand/assets/muse-mark.png";
import chatgptIcon from "@agentstudio/brand/assets/chatgpt.png";
import cueIcon from "@agentstudio/brand/assets/cue.png";
import { api, key } from "./api";
import { desktopBridge } from "./native";
import { Avatar } from "./ContactAvatar";
import { DeviceSharing } from "./DeviceSharing";
import { RemoteNodes } from "./RemoteNodes";
import { MCPAccess } from "./MCPAccess";
import { NangoConnect, NangoSession } from "./NangoConnect";
import type { NativeIntegrationReply, NativeIntegrationRequest, PersonalServiceId } from "./desktop-contract";
import type { Bootstrap, Integrations, LocalAgent } from "./types";

const PROVIDERS: { id: PersonalServiceId; name: string; description: string; icon: string }[] = [
  { id: "grokbot", name: "Grok Bot", description: "连接你已有的 Grok Bot", icon: grokIcon },
  { id: "muse", name: "Muse", description: "使用你的 Muse 助手", icon: museIcon },
  { id: "dots", name: "ChatGPT Dots", description: "连接 ChatGPT 中的个人 Agent", icon: chatgptIcon },
  { id: "cue", name: "Cue", description: "登录 Manus；为本工作间创建可撤销密钥，连接该账号的 Cue 助手", icon: cueIcon },
];
const FLOW_KEY = "agentstudio.personal.native-connection-flow";
const terminal = (state: string) => ["ready", "failed", "cancelled"].includes(state);
type Flow = { flowId: string; scope: "local" | "service"; title: string; progress: NativeIntegrationReply };
const message = (error: unknown) => error instanceof Error ? error.message : "暂时无法完成，请稍后重试。";
const webLink = (value?: string) => {
  try { const url = new URL(value || ""); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
};
function restoreFlow(): Flow | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(FLOW_KEY) || "null");
    if (saved && typeof saved.flowId === "string" && saved.flowId.length <= 200 && ["local", "service"].includes(saved.scope))
      return { flowId: saved.flowId, scope: saved.scope, title: typeof saved.title === "string" ? saved.title.slice(0, 100) : "连接进度", progress: { state: "waiting", message: "正在核对之前的连接进度…" } };
  } catch { /* A stale session entry must not prevent opening preferences. */ }
  return null;
}
function rememberFlow(flow: Flow | null) {
  try {
    if (flow && !terminal(flow.progress.state)) sessionStorage.setItem(FLOW_KEY, JSON.stringify({ flowId: flow.flowId, scope: flow.scope, title: flow.title }));
    else sessionStorage.removeItem(FLOW_KEY);
  } catch { /* No credentials or input values are persisted here. */ }
}
function Row({ icon, name, description, action, children, testId }: {
  icon: ReactNode; name: string; description?: ReactNode; action?: ReactNode; children?: ReactNode; testId?: string;
}) {
  return <div className="integration-row" data-testid={testId}>
    <div className="integration-symbol" aria-hidden="true">{icon}</div>
    <div className="integration-copy"><strong>{name}</strong>{description && <p>{description}</p>}{children}</div>
    {action && <div className="integration-actions">{action}</div>}
  </div>;
}

export function Connections({ data, onRefresh }: { data: Bootstrap; onRefresh: () => Promise<void> }) {
  const desktop = desktopBridge();
  const nativeAvailable = Boolean(desktop?.nativeIntegration);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [catalog, setCatalog] = useState<NativeIntegrationReply | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [flowError, setFlowError] = useState("");
  const [notice, setNotice] = useState("");
  const [removalWarnings, setRemovalWarnings] = useState<{ id: string; name: string }[]>([]);
  const [flow, setFlow] = useState<Flow | null>(restoreFlow);
  const [inputValue, setInputValue] = useState("");
  const [ownOpen, setOwnOpen] = useState(false);
  const [ownUrl, setOwnUrl] = useState("");
  const [ownToken, setOwnToken] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualAdding, setManualAdding] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<"a2a" | "mcp">("a2a");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const mounted = useRef(true), busyRef = useRef(false), loadVersion = useRef(0), flowRef = useRef(flow);
  flowRef.current = flow;
  const requestBodies = useRef(new Map<string, { signature: string; body: Record<string, unknown> }>());
  const loginInput = useRef<HTMLInputElement>(null);
  const native = useCallback((request: NativeIntegrationRequest) => {
    if (!desktop?.nativeIntegration) return Promise.reject(new Error("请在 AgentRoom Mac 应用中连接个人 Agent。"));
    return desktop.nativeIntegration(request);
  }, [desktop]);
  const nativeAction = async (request: NativeIntegrationRequest) => {
    const reply = await native(request);
    if (reply.state === "failed") throw new Error(reply.message || "暂时无法完成，请检查原服务后重试。");
    return reply;
  };
  const reload = useCallback(async (force = false) => {
    const version = ++loadVersion.current;
    const current = () => mounted.current && version === loadVersion.current;
    // Native service enumeration can wait on an unrelated provider. It must
    // not hold local discovery, server nodes or a completed enrollment hostage.
    if (nativeAvailable) void native({ kind: "services" }).then(value => {
      if (current()) setCatalog(value);
    }).catch(error => { if (current()) setError(message(error)); });
    try {
      const value = await api<Integrations>(force ? "/integrations/refresh" : "/integrations", force ? {} : undefined);
      if (current()) setIntegrations(value);
    } catch (error) { if (current()) setError(message(error)); }
    finally { if (current()) setLoading(false); }
  }, [native, nativeAvailable]);
  useEffect(() => {
    mounted.current = true; void reload();
    return () => { mounted.current = false; loadVersion.current++; };
  }, [reload]);
  useEffect(() => {
    if (!nativeAvailable) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      if (!busyRef.current) {
        const version = loadVersion.current;
        try {
          const latest = await native({ kind: "services" });
          if (!stopped && mounted.current && !busyRef.current && version === loadVersion.current) setCatalog(latest);
        } catch { /* Keep the last known catalog; explicit refresh reports failures. */ }
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [native, nativeAvailable]);
  const refresh = useCallback(async (force = false) => { await onRefresh(); await reload(force); }, [onRefresh, reload]);
  const applyProgress = useCallback(async (reply: NativeIntegrationReply, context: Pick<Flow, "scope" | "title"> & { flowId?: string }) => {
    if (reply.state === "catalog") { if (mounted.current) setCatalog(reply); return; }
    const flowId = reply.flowId || context.flowId;
    if (!flowId) throw new Error(reply.message || "连接未返回可核对的进度，请重新检查。");
    const current = flowRef.current;
    if (context.flowId && current && current.flowId !== context.flowId) return;
    if (current?.flowId === flowId && terminal(current.progress.state) && !terminal(reply.state)) return;
    const next: Flow = { flowId, scope: context.scope, title: context.title, progress: reply };
    rememberFlow(next); flowRef.current = next;
    if (!mounted.current) return;
    setFlow(next); setFlowError("");
    if (reply.state === "ready") {
      setNotice(context.scope === "local" ? "登录配置已更新，可以在这台 Mac 中选择使用。" : "个人 Agent 已连接。发送资料前仍会核对本次范围。");
      await refresh(context.scope === "local");
    }
  }, [refresh]);
  useEffect(() => {
    if (!flow || terminal(flow.progress.state) || !nativeAvailable) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      if (!busyRef.current) {
        try {
          const reply = await native({ kind: flow.scope === "local" ? "local-login-status" : "progress", flowId: flow.flowId });
          if (!stopped) await applyProgress(reply, flow);
        } catch (e) { if (!stopped) setFlowError(message(e)); }
      }
      if (!stopped) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [flow?.flowId, flow?.scope, flow?.progress.state, nativeAvailable, native, applyProgress]);
  useEffect(() => { if (flow?.progress.state === "input") loginInput.current?.focus(); }, [flow?.flowId, flow?.progress.state]);
  const perform = async (id: string, work: () => Promise<unknown>, reloadAfter = true) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(id); setError(""); setNotice("");
    try { await work(); if (reloadAfter && mounted.current) await refresh(); }
    catch (e) { if (mounted.current) setError(message(e)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(""); }
  };
  const removeConnection = async (connection: { id: string; name: string }) => {
    const receipt = await api<{ remoteRevocation?: string }>(`/connections/${encodeURIComponent(connection.id)}`, undefined, "DELETE");
    if (receipt.remoteRevocation === "unconfirmed") {
      setRemovalWarnings(previous => [...previous.filter(item => item.id !== connection.id), { id: connection.id, name: connection.name }]);
    }
  };
  const bodyFor = (id: string, input: Record<string, unknown>) => {
    const signature = JSON.stringify(input), previous = requestBodies.current.get(id);
    if (previous?.signature === signature) return previous.body;
    const body = { ...input, clientId: key() }; requestBodies.current.set(id, { signature, body }); return body;
  };
  const beginService = (id: PersonalServiceId, title: string) => perform(`service-${id}`, async () => {
    setInputValue(""); await applyProgress(await native({ kind: "connect", serviceId: id }), { scope: "service", title });
  }, false);
  const beginLogin = (agent: LocalAgent) => {
    if (agent.id !== "codex" && agent.id !== "claude") return;
    const agentId = agent.id;
    return perform(`login-${agentId}`, async () => {
      setInputValue(""); await applyProgress(await native({ kind: "local-login", agentId }), { scope: "local", title: `${agent.name} 登录` });
    }, false);
  };
  const activeFlow = Boolean(flow && !terminal(flow.progress.state));
  const selected = integrations?.selectedLocalAgentId || data.settings.localAgentId || "codex";
  const localRow = (agent: LocalAgent) => <Row key={agent.id} testId={`personal-local-agent-${agent.id}`} icon={<Avatar contact={{ name: agent.name, color: "blue", kind: "agent", avatarAgent: agent.id }} size="small" />} name={agent.name}
    description={<>{agent.version && <span className="integration-version">{agent.version} · </span>}{!agent.installed ? (agent.execution.supported ? "尚未安装" : "尚未安装；当前只支持发现，不能执行") : !agent.execution.supported ? "已安装；此版本尚不支持在这里执行" : agent.auth.status === "configured" ? "使用这台 Mac 已有的登录配置" : agent.auth.status === "required" ? "已安装，完成登录后即可使用" : "登录状态待确认"}</>}
    action={!agent.installed ? (webLink(agent.setupUrl) && <a className="integration-button" data-testid={`personal-local-install-${agent.id}`} href={webLink(agent.setupUrl)!} target="_blank" rel="noreferrer noopener">安装<ArrowUpRight size={13} /></a>)
      : !agent.execution.supported ? <span className="integration-state">暂未支持</span>
      : agent.auth.status === "configured" ? <button className={`integration-button${selected === agent.id ? " is-selected" : ""}`} data-testid={`personal-local-use-${agent.id}`} disabled={Boolean(busy) || selected === agent.id} onClick={() => void perform(`use-${agent.id}`, () => api(`/integrations/local/${agent.id}`, {}))}>{selected === agent.id ? <><Check size={14} />正在使用</> : busy === `use-${agent.id}` ? "正在切换…" : "使用"}</button>
      : agent.auth.status === "required" && nativeAvailable && ["codex", "claude"].includes(agent.id) ? <button className="integration-button" data-testid={`personal-local-login-${agent.id}`} disabled={Boolean(busy) || activeFlow} onClick={() => void beginLogin(agent)}>登录</button>
      : <button className="integration-button" disabled={Boolean(busy)} onClick={() => void perform("refresh", () => reload(true), false)}>检查登录</button>} />;
  const nativeIds = new Set((catalog?.instances || []).map(item => item.connectionId).filter(Boolean));
  const presetIds = new Set((integrations?.presets || []).map(item => item.connectionId).filter(Boolean));
  const custom = data.connections.filter(item => !item.node && !nativeIds.has(item.id) && !presetIds.has(item.id));
  const current = flow?.progress;

  return <div className="connections" data-testid="personal-connections">
    <nav className="integration-jumps" aria-label="连接分区">{([["mac", "这台 Mac"], ["agents", "个人 Agent"], ["servers", "其他服务器"], ["tools", "常用能力"]] as const).map(([id, label]) => <button key={id} data-testid={`personal-jump-${id}`} onClick={event => {
      const heading = document.getElementById(id === "servers" ? "connections-nodes-title" : `connections-${id}-title`);
      if (heading) {
        heading.tabIndex = -1;
        const panel = event.currentTarget.closest(".preferences-content");
        const offset = (event.currentTarget.closest("nav")?.getBoundingClientRect().height || 58) + (panel ? parseFloat(getComputedStyle(panel).paddingTop) || 0 : 0) + 12;
        if (panel) panel.scrollTop += heading.getBoundingClientRect().top - panel.getBoundingClientRect().top - offset;
        heading.focus({ preventScroll: true });
      }
    }}>{label}</button>)}</nav>
    <section className="integration-section" aria-labelledby="connections-mac-title">
      <div className="integration-section-heading"><h3 id="connections-mac-title" tabIndex={-1}>这台 Mac</h3><button className="text-button" data-testid="personal-integrations-refresh" disabled={Boolean(busy)} onClick={() => void perform("refresh", () => reload(true), false)}><RefreshCw size={14} className={busy === "refresh" ? "working" : ""} />重新检查</button></div>
      <p className="integration-intro">选择之后开始的执行所用助手，正在进行的事情保持原来的安排。</p>
      {loading && <p className="integration-loading" role="status"><Loader2 size={15} className="working" />正在检查本机助手…</p>}
      {integrations?.agents.filter(agent => ["codex", "claude", "pi"].includes(agent.id)).map(localRow)}
      {integrations && <details className="integration-details"><summary>其他助手</summary>{integrations.agents.filter(agent => !["codex", "claude", "pi"].includes(agent.id)).map(localRow)}</details>}
      <Row icon={<FileText size={19} />} name="本地资料整理" description="统计与保存原文，不调用模型" action={<span className="integration-state">始终可用</span>} />
      <p className="integration-note">登录状态只说明本机配置可读，不代表账号归属、额度或某次任务已完成。</p>
    </section>

    <section className="integration-section" aria-labelledby="connections-agents-title">
      <div className="integration-section-heading"><h3 id="connections-agents-title" tabIndex={-1}>你的个人 Agent</h3></div>
      <p className="integration-intro">使用原有对话；不会导入历史。外发资料仍会先展示具体内容，再由你决定。</p>
      {!nativeAvailable && <p className="integration-note">在 AgentRoom Mac 应用中连接这些助手。</p>}
      {PROVIDERS.map(provider => {
        const instances = (catalog?.instances || []).filter(item => item.service === provider.id);
        const connected = instances.some(item => item.status === "ready" && item.connectionId);
        const InstanceGroup = instances.length > 2 ? "details" : "div";
        const needsAttention = instances.filter(item => item.status !== "ready" || !item.connectionId).length;
        return <div key={provider.id} className="integration-provider">
          <Row icon={<img src={provider.icon} alt="" />} name={provider.name} description={provider.description}
            action={<button className="integration-button" data-testid={`personal-service-connect-${provider.id}`} disabled={!nativeAvailable || Boolean(busy) || activeFlow || connected} onClick={() => void beginService(provider.id, provider.name)}>{connected ? <><Check size={14} />已连接</> : busy === `service-${provider.id}` ? "正在打开…" : instances.length ? "重新连接" : "连接"}</button>} />
          <InstanceGroup className={instances.length > 2 ? "integration-instances" : undefined} data-testid={`personal-service-instances-${provider.id}`}>
          {instances.length > 2 && <summary data-testid={`personal-service-instances-toggle-${provider.id}`}>{instances.length} 个助手 · 查看与管理{needsAttention > 0 && <small>{needsAttention} 个需要检查</small>}</summary>}
          {instances.map(instance => {
            const instanceId = instance.id || instance.instanceId;
            return <div key={instanceId || instance.name} className="integration-instance" data-testid="personal-service-instance"><Avatar contact={{ name: instance.name, kind: "agent", color: "teal", avatarService: instance.service, avatarDataUrl: instance.avatarDataUrl }} size="small" /><div><strong title={instance.name}>{instance.name}</strong><p>{instance.status === "ready" ? (instance.connectionId ? "已连接" : "登录已保存，尚未接入工作间") : instance.hasCredentials === false ? "登录记录未恢复，聊天与原消息已保留" : instance.status === "needs_login" ? "需要重新登录" : ["starting", "reconnecting"].includes(instance.status || "") ? "正在连接" : "需要检查"}{!instance.canOpen && " · 需要确认时请到原 App 处理"}</p></div><div className="integration-actions">
              {instance.status === "ready" && !instance.connectionId && instanceId && <button className="integration-button" data-testid="personal-service-reconnect" disabled={Boolean(busy)} onClick={() => void perform(`reconnect-${instanceId}`, () => nativeAction({ kind: "reconnect", instanceId }))}>继续连接</button>}
              {instance.canOpen && instanceId && <button className="integration-button" disabled={Boolean(busy)} onClick={() => void perform(`open-${instanceId}`, () => nativeAction({ kind: "open", instanceId }), false)}>打开<ArrowUpRight size={13} /></button>}
              {instanceId && instance.hasCredentials !== false && <button className="icon-button" data-testid={`personal-service-remove-${instanceId}`} aria-label={`移除 ${instance.name}`} disabled={Boolean(busy)} onClick={() => void perform(`remove-${instanceId}`, () => nativeAction({ kind: "remove", instanceId }))}><Trash2 size={16} /></button>}
            </div></div>;
          })}
          </InstanceGroup>
        </div>;
      })}
      {(catalog?.instances || []).filter(instance => !instance.service).map(instance => <div className="integration-instance" data-testid="personal-service-missing" key={instance.id}>
        <div><strong>{instance.name}</strong><p>原登录记录未恢复。请在上方连接对应服务，聊天与原消息已保留。</p></div>
      </div>)}
      {flow && current && <div className={`integration-flow flow-${current.state}`} data-testid="personal-integration-flow" aria-label={flow.title}>
        <div className="integration-flow-heading"><strong>{flow.title}</strong>{terminal(current.state) && <button className="icon-button" aria-label="关闭连接进度" onClick={() => { rememberFlow(null); flowRef.current = null; setFlow(null); setInputValue(""); }}><X size={16} /></button>}</div>
        <p role="status" aria-live="polite">{current.message || (current.state === "ready" ? "连接已就绪。" : current.state === "cancelled" ? "已取消连接。" : current.state === "failed" ? "暂时没有完成连接，可以重新开始。" : "请在打开的登录页面完成操作；这里会继续核对进度。")}</p>
        {current.state === "waiting" && <div className="integration-flow-actions"><Loader2 className="working" size={15} /><span>等待本机确认</span></div>}
        {current.state === "waiting" && webLink(current.link?.url) && <details className="integration-details integration-login-link"><summary>改用常用浏览器登录</summary>
          <div className="integration-flow-input">
          <label>{current.link!.label}<input readOnly value={webLink(current.link?.url)!} aria-label="本次 Grok 登录链接" data-testid="personal-integration-login-url" onFocus={event => event.currentTarget.select()} /></label>
          <button className="integration-button" data-testid="personal-integration-copy-login" disabled={Boolean(busy)} onClick={() => void perform("copy-login", async () => { await applyProgress(await native({ kind: "choose", flowId: flow.flowId, choiceId: "copy-login" }), flow); setNotice("登录链接已复制。请在同一浏览器完成整轮验证，避免使用旧页面。"); }, false)}>复制登录链接</button>
          {current.expiresAt && <p className="field-help">本次将等待至 {new Date(current.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}。请从这个链接开始，并在同一浏览器完成登录。</p>}
          </div></details>}
        {(current.state === "choose" ? current.choices : current.state === "waiting" ? current.actions : [])?.map(choice => <button key={choice.id} className="integration-button" data-testid="personal-integration-choice" disabled={Boolean(busy)} onClick={() => void perform(`choose-${choice.id}`, async () => applyProgress(await native({ kind: "choose", flowId: flow.flowId, choiceId: choice.id }), flow), false)}>{choice.label}</button>)}
        {current.state === "input" && <form className="integration-flow-input" onSubmit={event => { event.preventDefault(); void perform("submit-login", async () => { await applyProgress(await native({ kind: "submit", flowId: flow.flowId, value: inputValue }), flow); if (mounted.current) setInputValue(""); }, false); }}><label>{current.label || "需要补充的信息"}<input ref={loginInput} data-testid="personal-integration-input" type={current.secret ? "password" : "text"} autoComplete={current.secret ? "new-password" : "off"} spellCheck={!current.secret} required maxLength={8000} disabled={Boolean(busy)} value={inputValue} onChange={event => setInputValue(event.target.value)} /></label>
          {current.link && webLink(current.link.url) && <a className="text-button" href={webLink(current.link.url)!} target="_blank" rel="noreferrer noopener">{current.link.label}<ArrowUpRight size={13} /></a>}
          {current.error && <p className="error-text" role="alert">{current.error}</p>}<button className="integration-button" data-testid="personal-integration-submit" disabled={Boolean(busy) || !inputValue.trim()}>继续</button></form>}
        {flowError && <p className="error-text" role="alert">{flowError} 进度已保留，会继续检查。</p>}
        {!terminal(current.state) && <button className="text-button" data-testid="personal-integration-cancel" disabled={Boolean(busy)} onClick={() => void perform("cancel-login", async () => { await applyProgress(await native({ kind: flow.scope === "local" ? "local-login-cancel" : "cancel", flowId: flow.flowId }), flow); setInputValue(""); }, false)}>取消这次连接</button>}
      </div>}
    </section>

    <DeviceSharing onRefresh={() => refresh()} />
    <RemoteNodes nodes={integrations?.nodes || []} onRefresh={() => refresh()} />

    <section className="integration-section" aria-labelledby="connections-tools-title">
      <div className="integration-section-heading"><h3 id="connections-tools-title" tabIndex={-1} data-testid="personal-connections-heading-tools">常用能力</h3></div>
      {(integrations?.presets || []).map(preset => <Row key={preset.id} icon={<Search size={19} />} name={preset.name} description={<>{preset.description}<span className="integration-account">{preset.account}</span></>}
        action={<><button className="integration-button" data-testid={`personal-preset-connect-${preset.id}`} disabled={Boolean(busy) || Boolean(preset.connectionId)} onClick={() => void perform(`preset-${preset.id}`, async () => { await api("/integrations/connect", bodyFor(`preset-${preset.id}`, { presetId: preset.id })); requestBodies.current.delete(`preset-${preset.id}`); })}>{preset.connectionId ? <><Check size={14} />已连接</> : busy === `preset-${preset.id}` ? "正在核对…" : "连接"}</button>{preset.connectionId && <button className="icon-button" aria-label={`断开 ${preset.name}`} disabled={Boolean(busy)} onClick={() => void perform(`disconnect-${preset.id}`, () => removeConnection({ id: preset.connectionId!, name: preset.name }))}><Unplug size={15} /></button>}</>} />)}
      {custom.map(connection => <Row key={connection.id} icon={<Unplug size={18} />} name={connection.name} description={connection.error || "已保存连接；发送资料前会核对本次范围"} action={<button className="icon-button" aria-label={`移除 ${connection.name}`} disabled={Boolean(busy)} onClick={() => void perform(`delete-${connection.id}`, () => removeConnection(connection))}><Trash2 size={16} /></button>}>
        {connection.nango && <NangoSession connection={connection} onRenewed={() => refresh()} />}
        <details className="integration-details"><summary>连接详情</summary><dl><dt>服务地址</dt><dd>{connection.url}</dd><dt>连接方式</dt><dd>{connection.type.toUpperCase()}</dd>{connection.auth?.configured && <><dt>认证</dt><dd>本机已保存访问凭据；身份与权限由对方服务验证。</dd></>}</dl></details>
      </Row>)}
      {removalWarnings.map(connection => <p className="nango-receipt-warning" role="status" key={connection.id} data-testid={`personal-nango-removal-receipt-${connection.id}`}>
        {connection.name} 已从本机移除。Nango 远端会话撤销尚未确认，可能保持有效至原会话过期；请到 Nango 核对。
      </p>)}
      <NangoConnect onConnected={() => refresh()} />
      <button className="text-button integration-own-toggle" data-testid="personal-own-service" aria-expanded={ownOpen} onClick={() => { setOwnOpen(!ownOpen); setOwnToken(""); }}><Plus size={15} />连接自己的服务</button>
      {ownOpen && <form className="integration-url-form" onSubmit={event => { event.preventDefault(); void perform("own-service", async () => { await api("/integrations/connect", bodyFor("own-service", { url: ownUrl, ...(ownToken ? { token: ownToken } : {}) })); requestBodies.current.delete("own-service"); if (mounted.current) { setOwnUrl(""); setOwnToken(""); setOwnOpen(false); } }); }}>
        <label>服务地址<input type="url" required placeholder="粘贴服务提供的连接地址" data-testid="personal-own-service-url" disabled={Boolean(busy)} value={ownUrl} onChange={event => setOwnUrl(event.target.value)} /></label>
        <details className="credential-details"><summary>需要访问凭据？</summary><label>访问令牌（可选）<input type="password" autoComplete="new-password" spellCheck={false} maxLength={8000} disabled={Boolean(busy)} value={ownToken} onChange={event => setOwnToken(event.target.value)} data-testid="personal-own-service-token" /></label><p className="field-help">凭据只用于这个连接，不交给模型。</p></details>
        <div className="form-actions"><button className="text-button" type="button" disabled={Boolean(busy)} onClick={() => { setOwnToken(""); setOwnOpen(false); }}>取消</button><button className="integration-button" disabled={Boolean(busy)} data-testid="personal-own-service-save">{busy === "own-service" ? "正在识别…" : "连接"}</button></div>
      </form>}
    </section>

    <MCPAccess refreshToken={data.connections} />

    <details className="integration-advanced" open={manualOpen}>
      <summary data-testid="personal-add-connection" onClick={event => { event.preventDefault(); setManualOpen(!manualOpen); setManualAdding(!manualOpen); setToken(""); }}>高级连接</summary>
      {manualAdding && <form className="connection-form" onSubmit={event => { event.preventDefault(); void perform("manual", async () => { await api("/connections", bodyFor("manual", { name, type, url, ...(token ? { token } : {}) })); requestBodies.current.delete("manual"); if (mounted.current) { setName(""); setUrl(""); setToken(""); setManualAdding(false); setManualOpen(false); } }); }}>
        <p className="field-help">仅在服务方要求手动设置时使用。连接不会导入历史；外发前仍需核对。</p>
        <label>名称<input required disabled={Boolean(busy)} value={name} onChange={event => setName(event.target.value)} placeholder="例如：我的研究助手" data-testid="personal-connection-name" /></label>
        <label>连接方式<select disabled={Boolean(busy)} value={type} onChange={event => setType(event.target.value as "a2a" | "mcp")} data-testid="personal-connection-type"><option value="a2a">远端 Agent（A2A）</option><option value="mcp">工具服务（MCP）</option></select></label>
        <label>服务地址<input required type="url" disabled={Boolean(busy)} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…" data-testid="personal-connection-url" /></label>
        <details className="credential-details"><summary data-testid="personal-connection-auth-toggle">连接需要访问凭据？</summary><label>访问令牌（可选）<input type="password" autoComplete="new-password" spellCheck={false} maxLength={8000} disabled={Boolean(busy)} value={token} onChange={event => setToken(event.target.value)} data-testid="personal-connection-token" /></label><p className="field-help">只用于本机服务向这个地址认证，不交给模型。</p></details>
        <div className="form-actions"><button className="text-button" type="button" disabled={Boolean(busy)} onClick={() => { setToken(""); setManualAdding(false); setManualOpen(false); }}>取消</button><button className="primary-button" disabled={Boolean(busy)} data-testid="personal-connection-save">{busy === "manual" ? "正在添加…" : "添加连接地址"}</button></div>
      </form>}
    </details>
    {notice && <p className="integration-notice" role="status">{notice}</p>}
    {error && <p className="error-text" role="alert" data-testid="personal-integrations-error">{error}</p>}
  </div>;
}
