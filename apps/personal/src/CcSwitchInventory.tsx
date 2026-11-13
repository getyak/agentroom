import type { CcSwitchExtensions, CcSwitchInventory as Inventory } from "./types";

function Extensions({ label, data }: { label: string; data: CcSwitchExtensions | null }) {
  if (!data || !data.enabled) return null;
  return <details className="integration-details"><summary>{label} · {data.enabled}</summary>
    <ul>{data.names.map((name, index) => <li key={index}>{name}</li>)}</ul>
    {data.truncated && <p className="integration-note">仅显示前 50 项；完整列表请在 CC Switch 中查看。</p>}
  </details>;
}

export function CcSwitchInventory({ inventory }: { inventory?: Inventory }) {
  if (!inventory || inventory.status === "not_found") return null;
  if (inventory.status === "unavailable") return <p className="integration-note" role="status" data-testid="personal-cc-switch-unavailable">暂时无法读取 CC Switch 配置；可点击「重新检查」重试。</p>;
  const amount = (value: number | null | undefined) => value == null ? "未识别" : String(value);
  return <details className="integration-details cc-switch-inventory" data-testid="personal-cc-switch">
    <summary>CC Switch 中的扩展配置</summary>
    <p className="integration-note">查看各助手已配置的工具与技能。这里显示配置来源；在 AgentRoom 中使用工具，需要另行连接。技能与提示词尚未导入联系人。</p>
    {inventory.clients.map(client => <div className="integration-copy" key={client.id} data-testid={`personal-cc-switch-${client.id}`}>
      <strong>{client.name}</strong>
      <p>供应商 {amount(client.providers?.total)} · 已选 {amount(client.providers?.selected)} · MCP {amount(client.mcp?.enabled)} · Skills {amount(client.skills?.enabled)} · 提示词 {amount(client.prompts)}</p>
      <Extensions label="已启用的 MCP" data={client.mcp} /><Extensions label="已启用的 Skills" data={client.skills} />
    </div>)}
    <p className="integration-note">项目配置 {amount(inventory.profiles)} 套 · 仅查看，配置仍由 CC Switch 管理。</p>
  </details>;
}
