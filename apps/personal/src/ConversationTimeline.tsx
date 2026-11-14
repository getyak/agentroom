import { Clock3, Copy, FileText, Reply, Square, SmilePlus } from "lucide-react";
import { Avatar } from "./ContactAvatar";
import { runLabel, runRecovery } from "./ConversationDetails";
import { conversationRows } from "./conversation-rows";
import { RichText } from "./Markdown";
import { DecisionView } from "./ConversationPanels";
import { approvalContact, approvalSender } from "./approval-identity";
import type { Approval, Attachment, Contact, Decision, Message, Run, Thread } from "./types";
import type { PersonalServiceId } from "./desktop-contract";

const date = (value: string) => new Date(value).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
export function ConversationTimeline({ thread, contacts, serviceAvatars, serviceImages = {}, limit, onMore, onReply, onContact, onSource, onRun, onReaction, onError, busy, onDecide, originalAction, onOpenChat }: {
  thread: Thread; contacts: Contact[]; serviceAvatars: Record<string, PersonalServiceId>; serviceImages?: Record<string, string>; limit: number; onMore: () => void; onReply: (message: Message) => void;
  onContact: (id: string) => void; onSource: (source: Attachment) => void;
  onRun: (run: Run, action: string) => void; onReaction: (message: Message, emoji: string, active: boolean) => void; onError: (error: string) => void; busy: string;
  onDecide?: (decision: Decision, choice: string) => void;
  onOpenChat?: (threadId: string) => void;
  originalAction?: (decision: Decision) => (() => void) | undefined;
}) {
  const allRows = conversationRows(thread).filter(row => !(thread.kind === "group" && row.type === "reply" && !row.messages.length && !row.run.progress?.text && ["queued", "running", "verifying"].includes(row.run.status))), rows = allRows.slice(-limit * 2);
  const recovery = (run: Run) => run.mode === "connection" && !run.externalTaskId && contacts.some(contact => contact.binding?.type === "connection" && contact.binding.connectionId === run.connectionId && contact.availability !== "ready")
    ? { action: "connection", label: "检查连接" } : runRecovery(run);
  const originalAvatar = (run: Run | undefined) => {
    const original = contacts.find(contact => contact.binding?.type === "connection" && contact.binding.connectionId === run?.connectionId);
    return { avatarService: (run?.connectionId && serviceAvatars[run.connectionId]) || original?.avatarService,
      avatarDataUrl: (run?.connectionId && serviceImages[run.connectionId]) || original?.avatarDataUrl };
  };
  const request = (decision: Decision) => {
    const run = thread.runs.find(item => item.id === decision.runId);
    const approval = { ...decision, contact: (decision as Approval).contact || run?.contactSnapshot || null } as Approval;
    const person = approvalContact(approval, contacts), sender = approvalSender(approval, person);
    return <div className="im-inline-decision" key={decision.id} data-testid="im-inline-decision"><div className="im-inline-decision-source"><Avatar contact={person} size="small" /><span>{sender.name === "发送者待核对" ? decision.identity?.label || sender.name : sender.name}</span></div><DecisionView decision={decision} busy={busy === decision.id || !onDecide} onDecide={choice => onDecide?.(decision, choice)} onOpenOriginal={originalAction?.(decision)} onOpenChat={onOpenChat} /></div>;
  };
  const bubble = (message: Message, run?: Run, preview = false) => {
    if (message.role === "system") return <div className="im-schedule-event" data-testid="im-schedule-event"><Clock3 size={13} /><RichText text={message.text} /></div>;
    const current = contacts.find(contact => contact.id === message.contactId);
    const sender = message.contactSnapshot ? { ...message.contactSnapshot, avatar: message.contactSnapshot.avatar ?? null, ...(run?.connectionId ? originalAvatar(run) : {}) } : current;
    const reply = message.replyTo ? thread.messages.find(item => item.id === message.replyTo) : null;
    const incoming = message.role !== "user", group = thread.kind === "group";
    const incomplete = preview && !["running", "verifying"].includes(run?.status || "");
    return <article className={`im-message ${incoming ? "incoming" : "outgoing"} ${group ? "im-group-message" : ""} ${preview ? "im-streaming" : ""}`} aria-label={incoming ? `${sender?.name || "助手"}的回复` : "你的消息"} data-testid={preview ? "im-streaming-message" : "im-message"} data-contact-id={message.contactId} data-message-id={message.id}>
      {incoming && group && <button className="im-message-avatar" aria-label={`查看${sender?.name || "助手"}`} title={sender?.name || "助手"} data-testid="im-message-avatar" disabled={!sender} onClick={() => sender && onContact(sender.id)}><Avatar contact={sender} size="small" /></button>}
      <div className="im-bubble" data-testid="im-message-content">
        {reply && <div className="im-reply-quote"><span>{reply.role === "user" ? "你" : reply.contactSnapshot?.name || "助手"}</span>{reply.text.slice(0, 120)}</div>}
        <RichText text={message.text} onSource={sourceId => { const found = thread.messages.flatMap(item => item.attachments || []).find(source => source.id === sourceId); if (found) onSource(found); else onError("找不到这处引用的原始资料"); }} />
        {message.attachments?.map((source, i) => <button className="im-attachment" key={source.id || i} onClick={() => onSource(source)}><FileText size={17} />{source.name}</button>)}
        {message.skippedContacts?.map(contact => <p className="im-field-hint" key={contact.id}>{contact.name} 未参与回复：{contact.reason}</p>)}
        {Boolean(message.reactions?.length) && <div className="im-reactions" data-testid={`im-reactions-${message.id}`} aria-label="消息回应">{[...new Set(message.reactions?.map(reaction => reaction.emoji))].map(emoji => {
          const actors = message.reactions!.filter(reaction => reaction.emoji === emoji), mine = actors.some(reaction => reaction.contactId === "self");
          const names = actors.map(reaction => reaction.contactId === "self" ? "你" : reaction.contactSnapshot?.name || contacts.find(contact => contact.id === reaction.contactId)?.name || "助手").join("、");
          return <button type="button" key={emoji} aria-pressed={mine} aria-label={`${names} 回应 ${emoji}`} title={names} data-testid={`im-reaction-${message.id}-${emoji}`} disabled={busy === message.id} onClick={() => onReaction(message, emoji, !mine)}><span>{emoji}</span>{actors.length > 1 && <small>{actors.length}</small>}</button>;
        })}</div>}
        {(incomplete || message.deliveryState === "local_only") && <p className="im-message-notice" role="status">{incomplete ? "未完成的回复" : "仅保存在本机"}</p>}
      </div>
      {!preview && <div className="im-message-actions" data-testid="im-message-actions"><button className="im-icon" aria-label="回复这条消息" data-testid="im-reply-message" onClick={() => onReply(message)}><Reply size={15} /></button><button className="im-icon" aria-label="复制消息" onClick={() => void navigator.clipboard.writeText(message.text).catch(() => onError("暂时无法复制，请选中文字复制"))}><Copy size={14} /></button><details className="im-reaction-picker"><summary className="im-icon" aria-label="回应这条消息" data-testid={`im-react-${message.id}`}><SmilePlus size={15} /></summary><div aria-label="选择回应表情">{["👍", "❤️", "😂", "🎉", "🤔", "👀", "✅"].map(emoji => <button type="button" key={emoji} data-testid={`im-react-choice-${message.id}-${emoji}`} aria-label={`回应 ${emoji}`} disabled={busy === message.id} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); onReaction(message, emoji, !(message.reactions || []).some(reaction => reaction.contactId === "self" && reaction.emoji === emoji)); }}>{emoji}</button>)}</div></details></div>}
    </article>;
  };
  return <>
    {allRows.length > rows.length && <button className="im-load-more" data-testid="im-load-more" onClick={onMore}>查看更早的消息</button>}
    {rows.map((row, i) => {
      const at = row.type === "message" ? row.message.createdAt : row.run.createdAt;
      const previous = rows[i - 1]; const previousAt = previous?.type === "message" ? previous.message.createdAt : previous?.run.createdAt;
      return <div key={row.id} className="im-message-group" data-testid={row.type === "reply" ? `im-response-${row.id}` : undefined}>
        {(!previousAt || date(at) !== date(previousAt)) && <div className="im-date"><span>{date(at)}</span></div>}
        {row.type === "message" ? bubble(row.message) : <>
          {row.messages.map(message => <div key={message.id}>{bubble(message, row.run)}</div>)}
          {thread.decisions.filter(decision => decision.runId === row.run.id).map(request)}
          {!row.messages.length && row.run.progress?.text && bubble({ id: `preview-${row.run.id}`, text: row.run.progress.text, role: "assistant", createdAt: row.run.startedAt || row.run.createdAt, contactId: row.run.contactId, contactSnapshot: row.run.contactSnapshot }, row.run, true)}
          {row.run.status !== "completed" && <div className={`im-reply-state ${row.run.status === "queued" ? "queued" : ""} ${["blocked", "failed", "unknown", "cancelled"].includes(row.run.status) ? "attention" : ""}`} data-testid="im-run-status" data-run-id={row.run.id}>
            {thread.kind === "group" && !row.messages.length && !row.run.progress?.text && <Avatar contact={row.run.contactSnapshot ? { ...row.run.contactSnapshot, avatar: row.run.contactSnapshot.avatar ?? null, ...originalAvatar(row.run) } : undefined} size="small" />}
            <div role="status" aria-live="polite"><span className="im-reply-label">{thread.kind === "group" && row.run.contactSnapshot?.name ? `${row.run.contactSnapshot.name} · ` : ""}{["running", "verifying"].includes(row.run.status) ? <><span className="im-typing-dots" aria-hidden="true"><i /><i /><i /></span>{row.run.progress?.phase === "thinking" ? "正在思考" : row.run.progress?.text ? "正在回复" : row.run.status === "verifying" ? "正在保存回复" : "正在准备回复"}</> : row.run.status === "queued" ? "已保存，等待助手处理" : runLabel(row.run)}</span>{row.run.error && <p>{row.run.error}</p>}</div>
            {["running", "queued", "verifying", "needs_input"].includes(row.run.status) ? <button className="im-icon" aria-label={`停止${row.run.contactSnapshot?.name || "助手"}`} data-testid={`im-run-stop-${row.run.id}`} disabled={busy === row.run.id} onClick={() => onRun(row.run, "cancel")}><Square size={13} /></button> : ["blocked", "failed", "unknown"].includes(row.run.status) || row.run.requiresReconciliation ? <button className="im-text-button" disabled={busy === row.run.id} onClick={() => onRun(row.run, recovery(row.run).action)}>{recovery(row.run).label}</button> : null}
          </div>}
        </>}
      </div>;
    })}
    {thread.decisions.filter(decision => !decision.runId || !thread.runs.some(run => run.id === decision.runId)).map(request)}
  </>;
}
