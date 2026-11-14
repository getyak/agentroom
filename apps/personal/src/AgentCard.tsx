import type { Contact } from "./types";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import "./agent-card.css";

const date = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const quotaReasons: Record<string, string> = { not_supported: "当前接入尚不支持读取额度", not_provided: "服务尚未提供额度数据", read_failed: "额度读取失败，稍后重试", login_required: "登录后可检查额度", provider_managed: "额度由模型提供商管理，尚未提供查询数据" };
const windowLabel = (minutes: number | null, index: number) => minutes ? minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟` : `用量窗口 ${index + 1}`;

/** Configuration and adapter facts only; never a model/usage verification claim. */
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
    <div className="im-agent-card-heading"><h3>Agent 名片</h3><button type="button" className="im-text-button" data-testid="im-agent-card-refresh" onClick={() => void refresh()} disabled={reading}>{reading ? "正在读取…" : "重新读取"}</button></div>
    <dl>
      <div><dt>所有者</dt><dd>我</dd></div>
      <div><dt>运行位置</dt><dd>{contact.presence?.deviceName || (local ? "这台 Mac" : "已连接的服务")}</dd></div>
      <div><dt>{contact.connectionType === "mcp" ? "工具接入" : "接入"}</dt><dd>{contact.providerName || "尚未确认"}</dd></div>
      {contact.connectionType === "mcp" && backend && <div><dt>对话助手</dt><dd>{backend}</dd></div>}
      <div><dt>模型</dt><dd data-testid="im-agent-card-model">{info?.model || configuration?.model || (local ? "尚未确认，请完善配置" : "服务尚未提供模型信息")}</dd></div>
      {(info?.provider || configuration?.provider) && <div><dt>模型提供商</dt><dd>{info?.provider || configuration?.provider}</dd></div>}
      <div><dt>思考深度</dt><dd data-testid="im-agent-card-thinking">{info?.thinking === "off" ? "关闭" : info?.thinking || configuration?.thinking || "服务尚未提供思考配置"}</dd></div>
      {local && <div><dt>配置方式</dt><dd>{contact.configuration?.modelMode === "fixed" ? "固定模型" : "跟随本机默认"}{contact.configuration?.thinking && contact.configuration.thinking !== "follow" ? " · 独立思考深度" : " · 跟随默认深度"}</dd></div>}
      <div><dt>账号额度</dt><dd data-testid="im-agent-card-quota">{quota?.status === "available" ? <>
        {quota.windows.map((window, index) => <div key={index}>{windowLabel(window.windowMinutes, index)}剩余 {Math.round(window.remainingPercent * 10) / 10}%{window.resetsAt && <small> · {date(window.resetsAt)} 重置</small>}</div>)}
        {quota.credits && <div>{quota.credits.unlimited ? "额度不限量（服务返回）" : `余额 ${quota.credits.balance} credits`}</div>}
        {quota.checkedAt && <small>更新于 {date(quota.checkedAt)}</small>}
      </> : quotaReasons[quota?.reason || "not_provided"] || quotaReasons.not_provided}</dd></div>
      <div><dt>使用范围</dt><dd>仅自己使用</dd></div>
    </dl>
    <div className="im-agent-card-capabilities" data-testid="im-agent-card-capabilities">{capabilities.length ? capabilities.map(item => <span key={item}>{item}</span>) : <span>接入能力尚未确认</span>}</div>
    <p>模型和思考深度是下次对话的配置；实际执行结果以该次回复记录为准。思考深度不代表跨模型的能力评分。</p>
    {info?.checkedAt && <p data-testid="im-agent-card-source">{info.source} · {date(info.checkedAt)}{stale ? " · 上次读取，当前状态待更新" : ""}</p>}
    <p>同一账号下的多个 Agent 可能共用额度。{quota?.status === "available" ? "额度以服务返回为准，不代表下一次请求一定可用。" : "额度未知不代表没有额度。"}</p>
    {contact.configurationError && <p className="im-agent-card-warning">{contact.configurationError}</p>}
    {error && <p className="im-agent-card-warning" role="alert" data-testid="im-agent-card-error">{error}</p>}
  </section>;
}
