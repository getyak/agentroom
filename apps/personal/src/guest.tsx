import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Loader2, Sparkles } from 'lucide-react';
import { GroupGuestConversation } from './GroupGuestConversation';
import type { GroupSnapshot } from './group-types';
import { GroupRequestError as GuestRequestError } from './group-errors';
import './styles.css';
import './messenger.css';
import './groups.css';
import { playCases, playError, type PlayPreview } from './play-types';
import './playrooms.css';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/g-api${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000), credentials: 'same-origin' });
  const result = await response.json(); if (!response.ok) throw new GuestRequestError(result.error?.message || '房间暂时没连上，稍后再试。', response.status, result.error?.code); return result;
}
function GuestApp() {
  const [invite] = useState(() => location.hash.slice(1));
  const [preview, setPreview] = useState<PlayPreview | null>(null), [room, setRoom] = useState<GroupSnapshot | null>(null), [nickname, setNickname] = useState('');
  const [error, setError] = useState(''), [joining, setJoining] = useState(false), [loading, setLoading] = useState(true), [disconnected, setDisconnected] = useState(false);
  const joinId = useRef(crypto.randomUUID()), inFlight = useRef(false);
  const roomId = location.pathname.match(/^\/g\/(pr_[A-Za-z0-9_-]+)$/)?.[1];
  useEffect(() => {
    let alive = true;
    const start = (async () => {
      if (roomId) {
        try { const current = await request<GroupSnapshot>(`/${roomId}`); if (alive) { history.replaceState(null, '', `/g/${current.id}`); setRoom(current); } return; }
        catch (e) { if (!invite || !(e instanceof GuestRequestError) || e.status !== 401) throw e; }
      }
      if (!invite) throw new Error('从朋友发来的完整邀请链接进来，就能一起玩。');
      const value = await request<PlayPreview>('/preview', { invite }); if (alive) setPreview(value);
    })();
    void start.catch(e => { if (alive) setError(playError(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [invite, roomId]);
  useEffect(() => {
    if (!room?.id) return;
    let alive = true, polling = false, terminal = false;
    const poll = async () => { if (polling || terminal) return; polling = true; try { const current = await request<GroupSnapshot>(`/${room.id}`); if (alive) { setRoom(previous => previous && (previous.version > current.version || previous.version === current.version && previous.thread.updatedAt > current.thread.updatedAt) ? previous : current); setDisconnected(false); } } catch (e) { if (alive) { terminal = e instanceof GuestRequestError && [401, 410].includes(e.status); setDisconnected(true); setError(playError(e)); } } finally { polling = false; } };
    const timer = setInterval(() => void poll(), 1800); return () => { alive = false; clearInterval(timer); };
  }, [room?.id]);
  const join = async () => {
    if (!nickname.trim() || inFlight.current) return; inFlight.current = true; setJoining(true); setError('');
    try { const current = await request<GroupSnapshot>('/join', { invite, nickname, clientId: joinId.current }); history.replaceState(null, '', `/g/${current.id}`); setRoom(current); }
    catch (e) { setError(playError(e)); } finally { setJoining(false); inFlight.current = false; }
  };
  const action = async (body: Record<string, unknown>) => { const current = await request<GroupSnapshot>(`/${room?.id}/actions`, body); setRoom(previous => previous && (previous.version > current.version || previous.version === current.version && previous.thread.updatedAt > current.thread.updatedAt) ? previous : current); return current; };
  const theme = preview && playCases[preview.template];
  return <main className="play-guest-root"><a className="play-brand" href="https://github.com/cubxxw/agentstudio" target="_blank" rel="noreferrer"><Sparkles size={19} />AgentRoom<span>留一间房，给我们。</span></a>
    {loading ? <div className="play-loading" role="status"><Loader2 className="play-spin" /><p>正在展开这份邀请…</p></div> : room ? <><GroupGuestConversation key={`${room.id}:${room.me.id}`} room={room} offline={disconnected} onAction={action} />{disconnected && <p data-testid="play-connection-state" className="play-error" role="status">{error}</p>}</> : preview && theme ? <section className={`play-invitation play-${preview.template}`} data-testid="play-invitation"><div className="play-invitation-art"><span>{theme.mark}</span><p>{preview.hostName} 留了一间房</p><div className="play-invite-seal">来玩</div></div><div className="play-invitation-copy"><small>{theme.tag}</small><h1>{preview.title}</h1><p className="play-invite-background">{preview.brief}</p><div className="play-invite-facts"><span><Sparkles size={15} />{preview.agentName}，AI 搭子</span><span>到 {new Date(preview.expiresAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div><form onSubmit={e => { e.preventDefault(); void join(); }}><label>大家怎么称呼你？<input autoComplete="nickname" data-testid="play-nickname" value={nickname} maxLength={32} placeholder="一个昵称就好" required onChange={e => { setNickname(e.target.value); joinId.current = crypto.randomUUID(); }} /></label><button type="submit" className="play-primary" data-testid="play-join" disabled={!nickname.trim() || joining}>{joining ? <Loader2 size={18} className="play-spin" /> : <Sparkles size={18} />}{joining ? '正在给你留座位…' : '接受邀请，加入群聊'}</button></form><p className="play-join-scope">接受邀请后可见本群已公开的背景、消息和作品，可以一起聊天、改便笺、玩小游戏。无需注册，也不需要提供你的其他资料。</p></div></section> : <section className="play-empty-invitation"><span>✳</span><h1>这扇门暂时没打开。</h1><p>{error}</p><button className="play-primary" onClick={() => location.reload()}>再试一次</button></section>}
    {error && !room && preview && <p className="play-error" role="alert">{error}</p>}<footer className="play-guest-footer">AI 会有不确定的时候。重要安排，一起确认后再行动。</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><GuestApp /></StrictMode>);
