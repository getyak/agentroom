import { useRef, useState } from "react";
import { ArrowRight, Check, Monitor, Search, Settings2, Sparkles, UserPlus } from "lucide-react";
import { api, key } from "./api";
import type { Bootstrap } from "./types";
import "./workspace-guide.css";

export function WorkspaceGuide({ data, onDiscover, onLocal, onConnect, onRoles, onSetup, onRefresh }: {
  data: Bootstrap; onDiscover: () => void; onLocal: () => void; onConnect: () => void; onRoles: () => void; onSetup: () => void; onRefresh: () => Promise<void>;
}) {
  const guide = data.workspace?.guide;
  const [name, setName] = useState(data.workspace?.displayName === "你" ? "" : data.workspace?.displayName || "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef<{ name: string; clientId: string } | null>(null);
  if (!guide) return null;
  const finish = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const ownerName = name.trim() || "你";
    if (pending.current?.name !== ownerName) pending.current = { name: ownerName, clientId: key() };
    try { await api("/workspace/onboarding", { action: "complete", ...pending.current }); await onRefresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "还没有保存，请再试一次"); }
    finally { setBusy(false); }
  };
  return <section className="roo-guide" data-testid="workspace-guide" aria-label="阿屋的引导卡">
    <div className="roo-guide-heading"><span className="roo-guide-eyebrow"><Monitor size={14} />从这台电脑开始</span><span className="roo-guide-status">{guide.agentId ? `由 ${guide.providerName} 陪你` : "等待连接助手"}</span></div>
    <h3>先把伙伴找齐。</h3>
    <p className="roo-guide-reason" data-testid="workspace-guide-backend">{guide.reason}</p>
    <div className="roo-guide-actions">
      <button onClick={onDiscover} data-testid="workspace-guide-discover"><Search size={19} /><span>认识这台电脑<small>环境、配置和已有伙伴</small></span><ArrowRight size={16} /></button>
      <button onClick={onLocal} data-testid="workspace-guide-local"><UserPlus size={19} /><span>添加本机助手<small>选择已安装的 Agent 作为联系人</small></span><ArrowRight size={16} /></button>
      <button onClick={onConnect} data-testid="workspace-guide-connect"><Settings2 size={19} /><span>连接已有伙伴<small>账号、工具和其他设备的联系人申请</small></span><ArrowRight size={16} /></button>
      <button onClick={onRoles} data-testid="workspace-guide-roles"><Sparkles size={19} /><span>一起准备角色<small>实际测试后，挑选适合你的建议</small></span><ArrowRight size={16} /></button>
      <button onClick={onSetup} data-testid="workspace-guide-setup"><Sparkles size={19} /><span>整理项目与组队<small>选择目录、补充资料、准备话题群</small></span><ArrowRight size={16} /></button>
    </div>
    {!data.workspace?.onboardingCompleted ? <form className="roo-guide-finish" onSubmit={event => { event.preventDefault(); void finish(); }}>
      <label htmlFor="roo-owner-name">怎么称呼你？<input id="roo-owner-name" data-testid="workspace-owner-name" value={name} maxLength={80} placeholder="你的名字（选填）" autoComplete="nickname" onChange={event => setName(event.target.value)} disabled={busy} /></label>
      <button type="submit" data-testid="workspace-guide-finish" disabled={busy}>{busy ? "正在保存…" : "准备好了"}<Check size={16} /></button>
    </form> : <p className="roo-guide-saved" data-testid="workspace-guide-completed"><Check size={14} />房间安顿好了，随时来找我。</p>}
    {error && <p className="im-error" role="alert">{error}</p>}
  </section>;
}
