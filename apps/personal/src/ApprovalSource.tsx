import { ChevronRight } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Avatar } from "./ContactAvatar";
import { approvalSender } from "./approval-identity";
import type { Approval, Contact } from "./types";

function ApprovalRequest({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false), [overflows, setOverflows] = useState(false);
  const content = useRef<HTMLParagraphElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => setOverflows(expanded ? node.scrollHeight > Number.parseFloat(getComputedStyle(node).lineHeight) * 4 + 1 : node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, text]);
  return <div>
    {overflows && <button className="im-text-button im-approval-request-toggle" data-testid="im-approval-request-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? "收起请求" : "展开完整请求"}</button>}
    <p ref={content} id={id} className={`im-approval-request${expanded ? " expanded" : ""}`} data-testid="im-approval-request-text">{text}</p>
  </div>;
}

export function ApprovalRow({ approval, contact, selected, onSelect }: { approval: Approval; contact?: Contact; selected: boolean; onSelect: () => void }) {
  const states: Record<string, string> = { pending: "等待决定", sending: "正在同步选择", unknown: "结果待核查", cancelled: "已失效" };
  const state = states[approval.state] || "已记录选择";
  const sender = approvalSender(approval, contact);
  const kind = approval.source?.threadKind === "group" ? "群聊" : approval.source?.threadKind === "direct" ? "私聊" : "任务对话";
  return <button className={`im-chat-row im-approval-row ${selected ? "selected" : ""}`} data-testid={`im-approval-${approval.id}`} onClick={onSelect}>
    <Avatar contact={contact ? { ...contact, name: sender.name } : undefined} activity={{ state: ["pending", "sending", "unknown"].includes(approval.state) ? "waiting" : "idle" }} />
    <span className="im-row-copy">
      <span className="im-approval-by"><span data-testid="im-approval-sender-name">{`由 ${sender.name} 发起`}</span><small>{state}</small></span>
      <strong>{approval.title}</strong>
      <small>{approval.source?.label || "来源待核对"}{contact?.handle ? ` · @${contact.handle}` : ""}{approval.source?.botId ? ` · ${approval.source.botId}` : ""}</small>
      <small>{kind} · {approval.threadTitle}</small>
    </span>
  </button>;
}

export function ApprovalSource({ approval, contact, canOpenContact, onContact, onChat }: { approval: Approval; contact?: Contact; canOpenContact: boolean; onContact: () => void; onChat: () => void }) {
  const original = approval.contact;
  const sender = approvalSender(approval, contact);
  const kind = approval.source?.threadKind === "group" ? "群聊" : approval.source?.threadKind === "direct" ? "私聊" : "任务对话";
  return <section className="im-approval-source" data-testid="im-approval-source" aria-label="审批来源">
    <div className="im-approval-sender">
      <Avatar contact={contact ? { ...contact, name: sender.name } : undefined} size="large" activity={{ state: ["pending", "sending", "unknown"].includes(approval.state) ? "waiting" : "idle" }} />
      <div><span className="im-muted">申请发送者</span><h2 data-testid="im-approval-sender-name">{canOpenContact ? <button data-testid="im-approval-contact" onClick={onContact}>{sender.name}<ChevronRight size={17} /></button> : sender.name}</h2>
        {sender.unnamed && <p>原服务尚未命名（New Bot），以上标识用于区分这个机器人。</p>}
        {contact?.handle && <p>@{contact.handle}</p>}
        {original && contact?.name !== original.name && <p>发起时：{original.name}</p>}
      </div>
    </div>
    <dl>
      <div><dt>Bot / 助手</dt><dd>{approval.source?.label || "来源待核对"}{approval.source?.name && approval.source.name !== approval.source.label && <span> · {approval.source.name}</span>}{approval.source?.botId && <small>Bot ID：<code>{approval.source.botId}</code></small>}</dd></div>
      <div><dt>原聊天</dt><dd><button className="im-text-button" data-testid="im-approval-source-chat" onClick={onChat}>{kind} · {approval.threadTitle}<ChevronRight size={15} /></button></dd></div>
      <div><dt>相关请求</dt><dd>{approval.source?.requestText ? <ApprovalRequest key={approval.id} text={approval.source.requestText} /> : <span className="im-muted">{approval.source?.botId ? "这张卡来自原服务，未关联本机发送的消息。" : "未保留关联的请求消息，可回到原聊天核对。"}</span>}</dd></div>
    </dl>
  </section>;
}
