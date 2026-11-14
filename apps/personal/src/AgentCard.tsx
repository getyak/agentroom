import type { Contact } from "./types";
import { useEffect, useRef, useState } from "react";
import { BrainCircuit, ChevronRight, CircleHelp, Cpu, Laptop, LockKeyhole, RefreshCw, Wallet } from "lucide-react";
import { api } from "./api";
import "./agent-card.css";

const date = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const quotaReasons: Record<string, string> = { not_supported: "当前接入尚不支持读取额度", not_provided: "服务尚未提供额度数据", read_failed: "额度读取失败，稍后重试", login_required: "登录后可检查额度", provider_managed: "额度由模型提供商管理，尚未提供查询数据" };
const windowLabel = (minutes: number | null, index: number) => minutes ? minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟` : `用量窗口 ${index + 1}`;

/** Dated adapter facts, presented as a compact calling card. */
export function AgentCard({ contact }: { contact: Contact }) {
  const [fresh, setFresh] = useState<Contact | null>(null), [reading, setReading] = useState(false), [error, setError] = useState("");
  const sequence = useRef(0);
  const signature = JSON.stringify([contact.id, contact.version, contact.binding, contact.chatBackend, contact.configuration, contact.configurationError, contact.presence?.state, contact.agentInfo]);
  const currentSignature = useRef(signature); currentSignature.current = signature;
  useEffect(() => { sequence.current++; setFresh(null); setReading(false); setError(""); return () => { sequence.current++; }; }, [signature]);
  const binding = contact.connectionType === "mcp" ? contact.chatBackend : contact.binding;
  const local = binding?.type === "local";
  const backend = binding?.type === "local" ? binding.localAgentId : null;
  const supported = backend !== null && ["codex", "claude", "pi"].includes(backend);
  const configuration = contact.execution;
  const info = fresh?.agentInfo || contact.agentInfo, quota = info?.quota;
  const stale = Boolean(info?.checkedAt && Date.now() - Date.parse(info.checkedAt) > 120_000) || ["offline", "reconnecting", "attention"].includes((fresh || contact).presence?.state || "");
  const model = info?.model || configuration?.model;
  const provider = info?.provider || configuration?.provider;
  const thinking = info?.thinking || configuration?.thinking;
  const location = contact.presence?.deviceName || (local ? "这台 Mac" : "已连接的服务");
  const refresh = async () => {
    if (reading) return;
    const current = ++sequence.current, accepted = signature; setReading(true); setError("");
    const active = () => current === sequence.current && accepted === currentSignature.current;
    try { const result = await api<Contact>(`/contacts/${contact.id}/info`, {}); if (active()) setFresh(result); }
    catch (error) { if (active()) setError(error instanceof Error ? error.message : "暂时无法读取，保留上次信息。"); }
    finally { if (active()) setReading(false); }
  };
  const capabilities = supported ? ["文字对话", "独立会话上下文", "停止本机执行", ...(["codex", "pi"].includes(backend!) ? ["正文进度"] : [])] : [];
  return <section className="im-agent-card" data-testid="im-agent-card" aria-label={`${contact.name}的名片`}>
    <div className="im-agent-card-heading"><h3><Cpu size={14} aria-hidden="true" />模型与额度</h3><button type="button" className="im-agent-card-refresh" data-testid="im-agent-card-refresh" onClick={() => void refresh()} disabled={reading}><RefreshCw size={13} aria-hidden="true" className={reading ? "working" : ""} />{reading ? "正在读取…" : "重新读取"}</button></div>
    <div className="im-agent-card-configuration">
      <div className="im-agent-card-model"><span className="im-agent-card-label">模型</span><strong data-testid="im-agent-card-model" className={!model ? "im-agent-card-unknown" : undefined}>{model || (local ? "尚未确认，请完善配置" : "服务尚未提供模型信息")}</strong>{provider && <span className="im-agent-card-provider">{provider}</span>}</div>
      <div className="im-agent-card-thinking"><span className="im-agent-card-label">思考深度</span><strong><BrainCircuit size={18} strokeWidth={1.5} aria-hidden="true" /><span data-testid="im-agent-card-thinking">{thinking === "off" ? "关闭" : thinking || "尚未提供"}</span></strong></div>
    </div>
    <div className="im-agent-card-usage" data-testid="im-agent-card-quota" data-available={quota?.status === "available"}>
      <div className="im-agent-card-usage-heading"><span><Wallet size={14} aria-hidden="true" />账户额度</span>{quota?.checkedAt && <time dateTime={quota.checkedAt}>更新于 {date(quota.checkedAt)}</time>}</div>
      {quota?.status === "available" ? <>
        {quota.windows.length > 0 && <div className="im-agent-card-windows">{quota.windows.map((window, index) => {
          const label = windowLabel(window.windowMinutes, index);
          const remaining = Math.round(window.remainingPercent * 10) / 10;
          return <div className="im-agent-card-window" key={index} data-low={remaining <= 20}>
            <div className="im-agent-card-balance"><span>{label}剩余 </span><strong>{remaining}<small>%</small></strong></div>
            <div className="im-agent-card-meter" role="meter" aria-label={`${label}剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} data-testid="im-agent-card-meter"><span style={{ width: `${remaining}%` }} /></div>
            {window.resetsAt && <time dateTime={window.resetsAt}>{date(window.resetsAt)} 重置</time>}
          </div>;
        })}</div>}
        {quota.credits && <div className="im-agent-card-credits">{quota.credits.unlimited ? "额度不限量（服务返回）" : <>余额 <strong>{quota.credits.balance}</strong> credits</>}</div>}
      </> : <p className="im-agent-card-no-quota"><CircleHelp size={17} strokeWidth={1.5} aria-hidden="true" />{quotaReasons[quota?.reason || "not_provided"] || quotaReasons.not_provided}</p>}
    </div>
    <div className="im-agent-card-context"><span><Laptop size={13} aria-hidden="true" />{location}</span><span><LockKeyhole size={12} aria-hidden="true" />仅自己使用</span></div>
    <div className="im-agent-card-footer"><details className="im-agent-card-details" data-testid="im-agent-card-details"><summary data-testid="im-agent-card-details-toggle"><ChevronRight size={13} aria-hidden="true" />接入详情</summary>
      <dl><div><dt>所有者</dt><dd>我</dd></div><div><dt>联系人标识</dt><dd>@{contact.handle}</dd></div><div><dt>{contact.connectionType === "mcp" ? "工具接入" : "接入"}</dt><dd>{contact.providerName || "尚未确认"}</dd></div>
        {contact.connectionType === "mcp" && backend && <div><dt>对话助手</dt><dd>{backend}</dd></div>}
        {local && <div><dt>配置方式</dt><dd>{contact.configuration?.modelMode === "fixed" ? "固定模型" : "跟随本机默认"}{contact.configuration?.thinking && contact.configuration.thinking !== "follow" ? " · 独立思考深度" : " · 跟随默认深度"}</dd></div>}
      </dl>
      <div className="im-agent-card-capabilities" data-testid="im-agent-card-capabilities">{capabilities.length ? capabilities.map(item => <span key={item}>{item}</span>) : <span>接入能力尚未确认</span>}</div>
      <p>模型和思考深度用于下次对话，实际执行以回复记录为准。</p>
      <p>同一账号下的多个 Agent 可能共用额度。{quota?.status === "available" ? "额度以服务返回为准。" : "额度未知不代表没有额度。"}</p>
    </details>
    {info?.checkedAt && <p className="im-agent-card-source" data-testid="im-agent-card-source">{stale && <span>上次读取 · </span>}{info.source} · {date(info.checkedAt)}</p>}
    </div>
    {contact.configurationError && <p className="im-agent-card-warning">{contact.configurationError}</p>}
    {error && <p className="im-agent-card-warning" role="alert" data-testid="im-agent-card-error">{error}</p>}
  </section>;
}
