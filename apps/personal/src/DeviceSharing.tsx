import { useEffect, useRef, useState } from "react";
import { Copy, Monitor, Share2 } from "lucide-react";
import { desktopBridge } from "./native";
import { api } from "./api";

type Sharing = {
  enabled: boolean; trustedPeerAddresses: string[]; name: string; host: string; addresses: string[]; url: string | null; state: string; error: string;
  contacts: { id: string; name: string; selected: boolean; canChat: boolean; canUseTools: boolean }[];
  requests: { id: string; contactName: string; threadId: string; state: string }[];
};
export function DeviceSharing({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [data, setData] = useState<Sharing | null>(null), [name, setName] = useState(""), [host, setHost] = useState("");
  const [trustedPeers, setTrustedPeers] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [invite, setInvite] = useState<{ url: string; token: string } | null>(null), [notice, setNotice] = useState("");
  const initialized = useRef(false), pending = useRef(false);
  const reload = async () => {
    const value = await api<Sharing>("/sharing"); setData(value);
    if (!initialized.current) { setName(value.name); setHost(value.host); setTrustedPeers((value.trustedPeerAddresses || []).join(", ")); setSelected(value.contacts.filter(c => c.selected).map(c => c.id)); initialized.current = true; }
  };
  useEffect(() => { let mounted = true; void reload().catch(e => { if (mounted) setError(e.message); }); return () => { mounted = false; }; }, []);
  const perform = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); await reload(); await onRefresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "设备共享尚未完成"); }
    finally { pending.current = false; setBusy(false); }
  };
  return <section className="integration-section device-sharing" data-testid="device-sharing" aria-labelledby="device-sharing-title">
    <div className="integration-section-heading"><h3 id="device-sharing-title"><Monitor size={17} />共享这台 Mac</h3><span className={`device-state ${data?.state === "online" ? "online" : ""}`} data-testid="device-sharing-state">{data?.state === "online" ? "共享中" : data?.enabled ? "等待连接" : "未开启"}</span></div>
    <p className="integration-intro">让另一台安装了 AgentRoom 的 Mac，通过 Tailscale 找到这里的伙伴。两边的账号和原聊天各自保留。</p>
    {data && <form className="connection-form" data-testid="device-sharing-form" onSubmit={event => { event.preventDefault(); void perform(async () => {
      setInvite(null); await api("/sharing", { enabled: true, name, host, contactIds: selected, trustedPeerAddresses: trustedPeers.split(/[\s,，]+/).filter(Boolean) });
    }); }}>
      <div className="device-sharing-fields"><label>设备名称<input required value={name} maxLength={80} data-testid="device-sharing-name" disabled={busy} onChange={e => setName(e.target.value)} /></label>
        <label>Tailscale 地址<select required value={host} disabled={busy} data-testid="device-sharing-address" onChange={e => setHost(e.target.value)}>{!data.addresses.length && <option value="">请先连接 Tailscale</option>}{data.addresses.map(address => <option key={address}>{address}</option>)}</select></label></div>
      <fieldset className="device-sharing-contacts" disabled={busy}><legend>对方能看到的联系人</legend>{data.contacts.length ? data.contacts.map(contact => <label key={contact.id} className="device-sharing-contact"><input type="checkbox" checked={selected.includes(contact.id)} data-testid={`device-share-${contact.id}`} onChange={e => setSelected(current => e.target.checked ? [...current, contact.id] : current.filter(id => id !== contact.id))} /><span><strong>{contact.name}</strong><small>{contact.canUseTools ? contact.canChat ? "可聊天 · 受信任设备也可用工具" : "受信任设备可用" : "目录可见"}</small></span></label>) : <p className="field-help">先添加一位本机助手或联系人，再选择共享。</p>}</fieldset>
      <label>可使用工具的设备<input value={trustedPeers} disabled={busy} data-testid="device-sharing-trusted-peers" aria-describedby="device-sharing-trusted-help" placeholder="对方的 Tailscale IPv4 地址" onChange={event => setTrustedPeers(event.target.value)} /></label>
      <p className="field-help" id="device-sharing-trusted-help">用逗号分隔多个地址。已连接的自有设备可以使用共享联系人的工具，并以这台 Mac 的账号权限执行任务。</p>
      {!data.addresses.length && <p className="integration-note">尚未检测到 Tailscale 地址。连接后关闭并重新打开设置，即可继续。</p>}
      <div className="form-actions"><button className="integration-button" disabled={busy || !host || !data.addresses.includes(host) || (!data.enabled && !selected.length)} data-testid="device-sharing-save"><Share2 size={14} />{busy ? "正在保存…" : data.enabled ? "保存共享设置" : "开启设备共享"}</button>
        {data.enabled && <button type="button" className="text-button" disabled={busy} data-testid="device-sharing-disable" onClick={() => void perform(async () => { setInvite(null); await api("/sharing", { enabled: false }); })}>停止共享</button>}</div>
    </form>}
    {data?.state === "online" && <div className="device-sharing-invite"><p>在另一台 Mac 的“设置 → 连接 → 其他设备”中，填写下面的地址和访问令牌。</p><button className="text-button" disabled={busy} data-testid="device-sharing-reveal" onClick={() => void perform(async () => { setInvite(invite ? null : await api("/sharing/invite", {})); })}>{invite ? "隐藏连接信息" : "显示连接信息"}</button>
      {invite && <div className="connection-form" data-testid="device-sharing-invite"><label>设备地址<input readOnly value={invite.url} data-testid="device-sharing-url" onFocus={e => e.target.select()} /></label><label>访问令牌<input readOnly type="password" autoComplete="off" value={invite.token} data-testid="device-sharing-token" onFocus={e => e.target.select()} /></label><button className="integration-button" disabled={busy} data-testid="device-sharing-copy" onClick={() => void perform(async () => { if (desktopBridge()?.copyDeviceInvitation) await desktopBridge()!.copyDeviceInvitation!(); else await navigator.clipboard.writeText(JSON.stringify(invite)); setNotice("连接信息已复制。在另一台 Mac 点“粘贴连接信息”即可填入。"); })}><Copy size={14} />复制连接信息</button><small>只发给你信任的设备。停止共享会阻止访问，重新开启后原设备可以继续连接。</small></div>}</div>}
    {data?.requests?.length ? <details className="device-sharing-requests"><summary>来自其他设备的请求 · {data.requests.length}</summary>{data.requests.map(request => <div className="integration-instance" key={request.id}><span>{request.contactName}<small>{({ completed: "已回复", working: "正在处理", submitted: "等待处理", unknown: "需要核查", failed: "未完成", "input-required": "等待处理" } as Record<string, string>)[request.state] || request.state}</small></span><button className="text-button" data-testid="device-sharing-open-request" onClick={() => window.dispatchEvent(new CustomEvent("agentroom:open-device-request", { detail: request.threadId }))}>查看请求</button></div>)}</details> : null}
    {(error || data?.error) && <p className="error-text" role="alert" data-testid="device-sharing-error">{error || data?.error}</p>}
    {notice && <p className="integration-notice" role="status">{notice}</p>}
    <p className="integration-note">关闭窗口后仍可共享；退出 AgentRoom 或 Mac 休眠后，对方会看到离线。</p>
  </section>;
}
