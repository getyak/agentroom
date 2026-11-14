import { useEffect, useRef, useState } from 'react';
import { Check, Download, Loader2, Send, Sparkles, Users } from 'lucide-react';
import { RichText } from './Markdown';
import { playCases, playError, type PlayAction, type PlayRoom } from './play-types';

export function PlayRoomView({ room, onAction, onRemove, offline = false }: { room: PlayRoom; onAction: (body: PlayAction) => Promise<PlayRoom>; onRemove?: (id: string) => Promise<void>; offline?: boolean }) {
  const [tab, setTab] = useState('chat'), [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [notes, setNotes] = useState(room.board.notes), [baseVersion, setBaseVersion] = useState(room.board.notesVersion), [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [taskEdits, setTaskEdits] = useState<Record<string, boolean>>({});
  const latestNotes = useRef(notes); latestNotes.current = notes;
  const latestMessage = useRef(message); latestMessage.current = message;
  const pending = useRef(new Map<string, { fingerprint: string; id: string }>()), sending = useRef(false), end = useRef<HTMLDivElement>(null);
  const theme = playCases[room.template];
  const unavailable = room.closed || offline;
  const working = room.jobs.filter(j => ['queued', 'running'].includes(j.status));
  const ownPending = working.some(j => j.actorId === room.me?.id);
  useEffect(() => { if (!dirty) { setNotes(room.board.notes); setBaseVersion(room.board.notesVersion); } }, [room.board.notes, room.board.notesVersion, dirty]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [room.messages.length]);
  const act = async (body: PlayAction) => {
    const fingerprint = JSON.stringify(body), prior = pending.current.get(body.type);
    const request = prior?.fingerprint === fingerprint ? prior : { fingerprint, id: crypto.randomUUID() };
    pending.current.set(body.type, request); setBusy(body.type); setError('');
    try { const next = await onAction({ ...body, clientId: request.id }); pending.current.delete(body.type); return next; }
    catch (e) { setError(playError(e)); throw e; }
    finally { setBusy(''); }
  };
  const send = async () => {
    if (!message.trim() || sending.current || ownPending) return;
    sending.current = true;
    const submitted = message;
    try { await act({ type: 'message', text: submitted }); if (latestMessage.current === submitted) setMessage(''); } catch {} finally { sending.current = false; }
  };
  const save = async () => {
    const submitted = notes;
    try { const next = await act({ type: 'notes', text: submitted, version: baseVersion }); setBaseVersion(next.board.notesVersion); if (latestNotes.current === submitted) setDirty(false); setConflict(false); }
    catch { setConflict(true); }
  };
  const setTask = async (taskId: string, done: boolean) => {
    setTaskEdits(current => ({ ...current, [taskId]: done }));
    try { await act({ type: 'task', taskId, done }); } catch {} finally { setTaskEdits(current => { const next = { ...current }; delete next[taskId]; return next; }); }
  };
  const download = () => {
    const text = `# ${room.title}\n\n${room.brief}\n\n## 共同便笺\n\n${room.board.notes}\n\n## 小分工\n\n${room.board.tasks.map(t => `- [${t.done ? 'x' : ' '}] ${t.label}`).join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = '一起写的计划.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className={`play-room play-${room.template}`} data-testid="play-room">
    <header className="play-room-heading"><div className="play-room-mark" aria-hidden="true">{theme.mark}</div><div><h2>{room.title}</h2><p><Sparkles size={13} />{room.agentName} · AI {room.template === 'twin' ? '分身' : '搭子'}</p></div><span className="play-room-life">{room.closed ? '这次相聚已结束' : `到 ${new Date(room.expiresAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}</span></header>
    <div className="play-people"><Users size={15} /><span>{room.participants.length} 位在这里</span><div>{room.participants.map((p, i) => <span className="play-person" key={p.id} title={`${p.name}${p.isOwner ? '（主人）' : ''}`} style={{ '--person-color': ['#bee6d2', '#f8db65', '#ffb6a3', '#c6d5ff'][i % 4] } as React.CSSProperties}>{p.name.slice(0, 1)}<span>{p.name}{p.isOwner ? ' · 主人' : p.id === room.me?.id ? ' · 你' : ''}</span>{onRemove && !p.isOwner && <button aria-label={`移除 ${p.name}`} onClick={() => void onRemove(p.id).catch(e => setError(playError(e)))}>×</button>}</span>)}</div></div>
    {room.closed && <p className="play-notice">这次相聚已经结束。大家留下的内容仍在这里，原邀请已失效。</p>}
    <div className="play-mobile-tabs"><button data-testid="play-tab-chat" aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>一起聊</button><button data-testid="play-tab-plan" aria-pressed={tab === 'plan'} onClick={() => setTab('plan')}>{room.template === 'travel' ? '旅行手册' : '一起写'}</button></div>
    <div className={`play-room-columns play-show-${tab}`}>
      <section className="play-chat" aria-label="房间讨论"><div className="play-message-list" data-testid="play-messages">
        <div className="play-start-note"><span>这次带来的背景</span><p>{room.brief}</p></div>
        {!room.messages.length && <div className="play-first-word"><span aria-hidden="true">✳</span><h3>{room.template === 'twin' ? '见字，也算见面。' : '好玩的事，从一句话开始。'}</h3><p>先打个招呼，或把一个还没想好的点子丢进来。</p><button onClick={() => setMessage(theme.prompt)}>{theme.prompt}</button></div>}
        {room.messages.map(m => <article key={m.id} className={`play-message ${m.role === 'assistant' ? 'from-agent' : m.actorId === room.me?.id ? 'from-me' : ''}`}><div className="play-message-meta"><strong>{m.name}</strong><span data-testid={`play-message-role-${m.role === 'assistant' ? 'agent' : m.actorId === 'self' ? 'owner' : 'guest'}`}>{m.role === 'assistant' ? 'AI' : m.actorId === 'self' ? '主人' : '访客'}</span><time>{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><div className="play-message-body"><RichText text={m.text} /></div></article>)}
        {working.length > 0 && <div className="play-working" role="status"><Loader2 size={15} className="play-spin" />{room.agentName}{working.some(j => j.status === 'running') ? '正在准备回复' : '会按顺序回复大家'}<span>还可聊 {room.remainingTurns} 轮</span></div>}
        {[...room.jobs.filter(j => j.status === 'unknown'), ...room.jobs.filter(j => j.status === 'failed').slice(0, 1)].map(j => <p className="play-notice" key={j.id}>{j.error || '这次执行需要主人核查。'}{room.me?.isOwner && j.status === 'unknown' && <button data-testid={`play-reconcile-${j.id}`} onClick={() => { if (window.confirm('请先核查本机原执行确实已经结束。确认后将结束待核查状态，不会重新运行。')) void act({ type: 'acknowledge', jobId: j.id, confirmedStopped: true }).catch(() => {}); }}>我已核查原执行结束</button>}</p>)}
        <div ref={end} />
      </div><form className="play-composer" onSubmit={e => { e.preventDefault(); void send(); }}><textarea data-testid="play-message" aria-label="说点什么" value={message} maxLength={4000} placeholder={room.template === 'twin' ? '小熊，想和你聊聊…' : '补充一个想法，或问问我们的 AI 搭子…'} disabled={unavailable} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><button data-testid="play-send" type="submit" aria-label="发送消息" disabled={!message.trim() || busy === 'message' || ownPending || unavailable || room.remainingTurns === 0}>{busy === 'message' ? <Loader2 size={20} className="play-spin" /> : <Send size={19} />}</button><small>只使用本房间公开的背景。Enter 发送，Shift Enter 换行。</small></form></section>
      <aside className="play-plan" aria-label="共同计划"><div className="play-plan-title"><h3>{room.template === 'travel' ? '旅行还没出发，期待先到了。' : room.template === 'project' ? '把点子留在同一张纸上。' : '聊着聊着，留下点什么。'}</h3><span>{theme.mark}</span></div>
        {room.board.choices.length > 0 && <section className="play-voting"><h4>这一趟，你想去哪种地方？</h4>{room.board.choices.map((c, i) => <button key={c.id} data-testid={`play-vote-${c.id}`} disabled={room.closed || busy === 'vote'} className={c.votes.includes(room.me?.id || '') ? 'chosen' : ''} onClick={() => void act({ type: 'vote', choiceId: c.id }).catch(() => {})}><span aria-hidden="true">{['⛰️', '🌊', '🏙️'][i]}</span><strong>{c.label}</strong><b data-testid={`play-votes-${c.id}`}>{c.votes.length}</b>{c.votes.includes(room.me?.id || '') && <Check size={15} />}</button>)}</section>}
        <section className="play-checklist"><h4>一起迈几小步 <span>{room.board.tasks.filter(t => t.done).length}/{room.board.tasks.length}</span></h4>{room.board.tasks.map(t => <label key={t.id}><input type="checkbox" data-testid={`play-task-${t.id}`} checked={taskEdits[t.id] ?? t.done} disabled={room.closed || busy === 'task'} onChange={e => void setTask(t.id, e.target.checked)} /><span>{t.label}</span></label>)}</section>
        <section className="play-notebook"><header><h4>共同便笺</h4><button data-testid="play-export" title="下载大家已保存的计划" aria-label="下载共同计划" onClick={download}><Download size={16} /></button></header><textarea data-testid="play-notes" aria-label="共同便笺" maxLength={12000} value={notes} disabled={unavailable} placeholder={room.template === 'project' ? '我们要做什么？谁来画第一笔？\n把草稿、分工和决定一起写下来。' : '日期、预算、饮食偏好，还有想一起做的事。'} onChange={e => { setNotes(e.target.value); setDirty(true); }} />
          <footer><small>{dirty ? '你的草稿还没保存' : `已保存 · 第 ${room.board.notesVersion} 版`}</small><button data-testid="play-save-notes" disabled={!dirty || busy === 'notes' || unavailable} onClick={() => void save()}>{busy === 'notes' ? '正在保存' : '留在这里'}</button></footer>
          {conflict && <div data-testid="play-notes-conflict" className="play-notice">保存未完成，你的草稿仍在上面。<button data-testid="play-load-latest" onClick={() => { setNotes(room.board.notes); setBaseVersion(room.board.notesVersion); setDirty(false); setConflict(false); }}>载入最新便笺，替换本地草稿</button></div>}
        </section>
      </aside>
    </div>{error && <p className="play-error" role="alert">{error}</p>}
  </div>;
}
