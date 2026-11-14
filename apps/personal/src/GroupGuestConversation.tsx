import { useEffect, useRef, useState } from 'react';
import { ArrowUp, MessageCircle, Shapes, Users } from 'lucide-react';
import { Avatar, groupAvatarMembers } from './ContactAvatar';
import { ConversationTimeline } from './ConversationTimeline';
import { GroupArtifacts } from './GroupArtifacts';
import { GroupRoster } from './GroupRoster';
import type { GroupArtifact, GroupArtifactAction, GroupSnapshot } from './group-types';
import type { Message } from './types';
import { definiteGroupRejection } from './group-errors';
import { restoreGroupDraft, type GroupEnvelope } from './group-draft';
export function GroupGuestConversation({ room, offline, onAction }: { room: GroupSnapshot; offline: boolean; onAction: (body: Record<string, unknown>) => Promise<GroupSnapshot> }) {
  const storageKey = `agentroom.group-draft.${room.id}.${room.me.id}`;
  const [restored] = useState(() => { try { return restoreGroupDraft(localStorage.getItem(storageKey), room.me.id); } catch { return restoreGroupDraft(null); } });
  const [tab, setTab] = useState('chat'), [draft, setDraft] = useState(restored.text), [reply, setReply] = useState<Message | null>(() => room.thread.messages.find(m => m.id === restored.replyTo) || null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [limit, setLimit] = useState(80), [pendingState, setPendingState] = useState(restored.pending);
  const current = useRef(draft); current.current = draft; const timeline = useRef<HTMLDivElement>(null), sending = useRef(false), pending = useRef<GroupEnvelope | null>(restored.pending);
  const persist = (text: string, envelope: GroupEnvelope | null, replyTo = reply?.id) => localStorage.setItem(storageKey, JSON.stringify({ version: 1, actorId: room.me.id, text, pending: envelope, ...(replyTo ? { replyTo } : {}) }));
  useEffect(() => { try { persist(draft, pending.current); } catch { /* The send path checks persistence before dispatch. */ } }, [draft, reply?.id, room.id]);
  useEffect(() => { const node = timeline.current; if (node && node.scrollHeight - node.scrollTop - node.clientHeight < 300) node.scrollTop = node.scrollHeight; }, [room.thread.messages.length]);
  const submit = async (envelope: GroupEnvelope) => {
    if (sending.current || offline) return; sending.current = true; setBusy(true); setError('');
    pending.current = envelope; setPendingState(envelope);
    try {
      persist(current.current, envelope);
      await onAction({ type: 'message', ...envelope }); pending.current = null; setPendingState(null);
      if (current.current === envelope.text) { setDraft(''); setReply(null); persist('', null, ''); } else persist(current.current, null);
    } catch (e) { if (definiteGroupRejection(e)) { pending.current = null; setPendingState(null); try { persist(current.current, null); } catch { /* Keep the visible draft. */ } } setError(e instanceof Error ? e.message : '没有确认发送，草稿和请求标识还在'); } finally { sending.current = false; setBusy(false); }
  };
  const send = async () => {
    if (!draft.trim() || sending.current || offline) return;
    // Reconcile an unconfirmed envelope before dispatching a different new draft.
    const envelope = pending.current || { text: draft, ...(reply ? { replyTo: reply.id } : {}), clientId: crypto.randomUUID() };
    await submit(envelope);
  };
  const artifactAction = async (body: GroupArtifactAction): Promise<GroupArtifact> => { const { action, ...input } = body; const result = await onAction({ type: action === 'create' ? 'artifact_create' : action === 'edit' ? 'artifact_edit' : 'artifact_act', ...input }); const artifact = body.artifactId ? result.artifacts.find(a => a.id === body.artifactId) : result.artifacts.find(a => !room.artifacts.some(old => old.id === a.id)); if (!artifact) throw new Error('作品已更新，正在同步'); return artifact; };
  return <section className="im-app group-guest-app" data-testid="group-guest-chat"><header className="im-header"><Avatar group size="small" members={groupAvatarMembers(room.thread.memberIds, room.contacts)} /><div className="im-header-copy"><strong>{room.title}</strong><small>{room.roster.filter(p => p.kind === 'human').length} 位朋友，{room.roster.filter(p => p.kind === 'agent').length} 位 AI 伙伴</small></div><details className="group-guest-people"><summary data-testid="group-guest-people" aria-label="查看群成员"><Users size={20} /></summary><GroupRoster roster={room.roster} /></details></header>
    <nav className="group-tabs"><button data-testid="group-guest-chat-tab" aria-current={tab === 'chat' ? 'page' : undefined} onClick={() => setTab('chat')}><MessageCircle size={16} />聊天</button><button data-testid="group-guest-artifacts" aria-current={tab === 'artifacts' ? 'page' : undefined} onClick={() => setTab('artifacts')}><Shapes size={16} />作品 {room.artifacts.length || ''}</button></nav>
    <div className={`group-guest-conversation ${tab !== 'chat' ? 'group-hidden' : ''}`}><div className="im-timeline" ref={timeline} data-testid="im-timeline"><details className="group-brief-summary"><summary>这次一起做什么</summary><p>{room.brief}</p></details><ConversationTimeline thread={room.thread} contacts={room.contacts} serviceAvatars={{}} viewerId={room.me.id} ownerControls={false} limit={limit} onMore={() => setLimit(n => n + 80)} onReply={setReply} onContact={() => {}} onSource={() => {}} onRun={() => {}} onReaction={(message, emoji, active) => { if (!offline) void onAction({ type: 'reaction', messageId: message.id, emoji, active, clientId: crypto.randomUUID() }).catch(e => setError(e instanceof Error ? e.message : '回应没有保存')); }} onError={setError} busy={busy ? 'sending' : ''} /></div>
      <div className="im-composer-area">{reply && <div className="im-composer-reply"><span>回复：{reply.text.slice(0, 70)}</span><button onClick={() => setReply(null)}>取消</button></div>}{error && <p className="group-error" role="alert">{error}</p>}{pendingState && !busy && <button className="im-text-button" data-testid="group-reconcile-send" disabled={offline} onClick={() => void submit(pendingState)}>核对上一条发送，再继续写</button>}<form className="group-guest-composer" onSubmit={e => { e.preventDefault(); void send(); }}><textarea aria-label="群消息" data-testid="group-message" value={draft} maxLength={4000} placeholder="说点什么，一起做点什么…" onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><button className="im-send" type="submit" data-testid="group-send" aria-label="发送消息" disabled={busy || offline || !draft.trim()}><ArrowUp size={20} /></button></form><small className="group-composer-caption">{offline ? '连接中断，草稿保留在这里' : `你是 ${room.me.id === 'self' ? '主人' : room.roster.find(p => p.id === room.me.id)?.name || '朋友'}。还可执行 ${room.remainingTurns} 次 Agent 任务。`}</small></div>
    </div><div className={`group-guest-works ${tab !== 'artifacts' ? 'group-hidden' : ''}`}><GroupArtifacts artifacts={room.artifacts} onAction={artifactAction} disabled={offline} /></div>
  </section>;
}
