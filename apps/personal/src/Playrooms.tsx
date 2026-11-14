import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, Link, Loader2, Sparkles } from 'lucide-react';
import { api, key } from './api';
import { desktopBridge } from './native';
import { Modal } from './ConversationPanels';
import { PlayRoomView } from './PlayRoom';
import { acceptPlaySnapshot, playCases, playError, type PlayRoom, type PlayTemplate, type PlayAction } from './play-types';
import type { Contact, Thread } from './types';
import './playrooms.css';

type RoomSummary = { id: string; template: PlayTemplate; title: string; closed: boolean; participantCount: number };
type Network = { state: string; url: string | null; error: string | null };
type Invitation = { roomId: string; url: string | null; localUrl: string };
export function Playrooms({ contacts, owner, thread, onClose }: { contacts: Contact[]; owner: string; thread?: Thread | null; onClose: () => void }) {
  const [template, setTemplate] = useState<PlayTemplate | null>(null), [room, setRoom] = useState<PlayRoom | null>(null), [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [title, setTitle] = useState(''), [brief, setBrief] = useState(''), [persona, setPersona] = useState(''), [hostName, setHostName] = useState(owner);
  const agents = contacts.filter(c => c.kind === 'agent' && c.binding?.type === 'local' && ['codex', 'pi'].includes(c.binding.localAgentId));
  const [agentId, setAgentId] = useState(agents.find(c => thread?.memberIds?.includes(c.id))?.id || agents[0]?.id || ''), [network, setNetwork] = useState<Network>({ state: 'off', url: null, error: null });
  const [invitation, setInvitation] = useState<Invitation | null>(null), [copied, setCopied] = useState<'public' | 'local' | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const createId = useRef(key()), creating = useRef(false);
  const roomId = room?.id;
  const loadList = () => api<{ rooms: RoomSummary[] }>('/playrooms').then(value => setRooms(value.rooms)).catch(e => setError(playError(e)));
  useEffect(() => { void loadList(); }, []);
  useEffect(() => {
    if (!roomId) return;
    let alive = true, running = false;
    const poll = async () => {
      if (running) return; running = true;
      try { const [current, state] = await Promise.all([api<PlayRoom>(`/playrooms/${roomId}`), api<Network>('/play-network')]); if (alive) { setRoom(previous => acceptPlaySnapshot(previous, current)); setNetwork(state); } }
      catch (e) { if (alive) setError(playError(e)); } finally { running = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 1800); return () => { alive = false; clearInterval(timer); };
  }, [roomId]);
  useEffect(() => {
    if (!roomId || room?.closed) return;
    let alive = true;
    void api<Invitation>(`/playrooms/${roomId}/invite`, {}).then(value => { if (alive) setInvitation(value); }).catch(e => { if (alive) setError(playError(e)); });
    return () => { alive = false; };
  }, [roomId, network.url, room?.closed]);
  const choose = (id: PlayTemplate) => { setTemplate(id); setTitle(playCases[id].title); setBrief(playCases[id].brief); setPersona(playCases[id].persona); setHostName(owner); setError(''); createId.current = key(); };
  const create = async () => {
    if (creating.current || !template) return; creating.current = true; setBusy(true); setError('');
    try { const created = await api<PlayRoom>('/playrooms', { clientId: createId.current, template, title, brief, persona, hostName, contactId: agentId }); setRoom(created); setInvitation(null); void loadList(); }
    catch (e) { setError(playError(e)); } finally { creating.current = false; setBusy(false); }
  };
  const act = async (body: PlayAction) => { const next = await api<PlayRoom>(`/playrooms/${roomId}/actions`, body); setRoom(previous => acceptPlaySnapshot(previous, next)); return next; };
  const remove = async (id: string) => {
    await act({ type: 'remove', participantId: id, clientId: key() });
    setCopied(null); setInvitation(await api<Invitation>(`/playrooms/${roomId}/invite`, {}));
  };
  const copy = async (local = false) => {
    setCopied(null); setError('');
    try {
      const url = invitation && invitation.roomId === roomId ? local ? invitation.localUrl : invitation.url : null;
      if (!url || !roomId) throw new Error('邀请通道还没准备好，再等一下。');
      const desktop = desktopBridge();
      if (desktop?.copyPlayInvitation) await desktop.copyPlayInvitation({ roomId, local });
      else await navigator.clipboard.writeText(url);
      setCopied(local ? 'local' : 'public');
    }
    catch (e) { setError(playError(e)); }
  };
  const startNetwork = async () => { setError(''); try { setNetwork(await api<Network>('/play-network', { action: 'start' })); } catch (e) { setError(playError(e)); } };
  const stopNetwork = async () => { setError(''); try { setNetwork(await api<Network>('/play-network', { action: 'stop' })); setCopied(null); } catch (e) { setError(playError(e)); } };
  return <Modal title="邀请朋友来玩" onClose={onClose} className="play-modal"><div className="play-shell">
    {room ? <>
      <div className="play-owner-bar"><button className="play-back" data-testid="play-back" onClick={() => { setRoom(null); setTemplate(null); setInvitation(null); setError(''); void loadList(); }}><ArrowLeft size={16} />所有房间</button><div>{!room.closed && <>{network.state === 'online' ? <button className="play-primary" data-testid="play-copy-invite" onClick={() => void copy()}>{copied === 'public' ? <Check size={16} /> : <Copy size={16} />}{copied === 'public' ? '邀请已复制' : '复制邀请'}</button> : <button className="play-primary" data-testid="play-network-start" disabled={network.state === 'starting'} onClick={() => void startNetwork()}>{network.state === 'starting' ? <Loader2 className="play-spin" size={16} /> : <Link size={16} />}{network.state === 'starting' ? '正在打开一扇门…' : '开启网页邀请'}</button>}<button className="play-quiet" data-testid="play-copy-local" disabled={!invitation || invitation.roomId !== roomId} onClick={() => void copy(true)}>{copied === 'local' ? '本机预览已复制' : '复制本机预览'}</button></>}{network.state === 'online' && <button className="play-quiet" data-testid="play-network-stop" onClick={() => void stopNetwork()}>停止网页邀请</button>}</div></div>
      {network.error && <p className="play-error" role="alert">{network.error}</p>}
      {!room.closed && <p className="play-owner-hint">{network.state === 'online' ? '朋友拿到链接，填昵称就能参与，能看到本房间全部聊天和计划。临时地址会在通道关闭后失效。' : '这里的聊天和计划会对加入的朋友可见。开启网页邀请后，朋友才能从其他设备进入。'}</p>}
      <PlayRoomView key={room.id} room={room} onAction={act} onRemove={remove} />
      {!room.closed && <footer className="play-owner-footer"><span>移除访客会更换旧邀请；结束房间会让所有访客会话失效，内容保留。</span><button data-testid="play-close-room" onClick={() => void act({ type: 'close', clientId: key() }).catch(e => setError(playError(e)))}>结束这间房</button></footer>}
    </> : template ? <div className={`play-create play-${template}`}>
      <button className="play-back" data-testid="play-back" onClick={() => { setTemplate(null); setError(''); }}><ArrowLeft size={16} />换个玩法</button>
      <header><span className="play-create-mark" aria-hidden="true">{playCases[template].mark}</span><div><p>{playCases[template].tag}</p><h2>带一点背景，邀请就成立了。</h2></div></header>
      <form onSubmit={e => { e.preventDefault(); void create(); }}><div className="play-form-pair"><label>房间叫什么<input data-testid="play-title" value={title} maxLength={80} required onChange={e => { setTitle(e.target.value); createId.current = key(); }} /></label><label>朋友怎么称呼你<input data-testid="play-host-name" value={hostName} maxLength={40} required onChange={e => { setHostName(e.target.value); createId.current = key(); }} /></label></div>
        <label>把哪位搭子带来<select data-testid="play-agent" value={agentId} required onChange={e => { setAgentId(e.target.value); createId.current = key(); }}><option value="">选择本机 Codex 或 Pi</option>{agents.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><small>沿用这位 Agent 的本机模型，只提供本房间资料与只读房间工具。</small></label>
        <label>朋友进来前，会先看到这些背景<textarea data-testid="play-brief" rows={4} maxLength={6000} value={brief} required onChange={e => { setBrief(e.target.value); createId.current = key(); }} /></label>
        {thread && <button type="button" className="play-context-import" onClick={() => { setBrief(`${thread.title}\n\n${thread.messages.slice(-8).map(m => m.text).join('\n\n')}`.slice(0, 6000)); createId.current = key(); }}>带入当前聊天最近 8 条文字，先在上面审核</button>}
        <details className="play-persona"><summary>分身说明，也由你决定</summary><textarea data-testid="play-persona" aria-label="分身说明" value={persona} rows={3} maxLength={1500} onChange={e => { setPersona(e.target.value); createId.current = key(); }} /></details>
        <div className="play-invitation-scope"><Sparkles size={20} /><div><strong>这一小间，刚刚好。</strong><p>有效 24 小时，最多 5 位访客，共 30 轮 AI 讨论。其他聊天、记忆和邮箱不进入房间。</p></div></div>
        {!agents.length && <p className="play-notice">先在联系人里添加本机 Codex 或 Pi，房间就能带上你的助手。</p>}
        <button type="submit" className="play-primary play-create-button" data-testid="play-create" disabled={busy || !agentId}>{busy ? <Loader2 size={18} className="play-spin" /> : <Sparkles size={18} />}{busy ? '正在布置房间…' : '开间房，看看邀请'}</button>
      </form>
    </div> : <div className="play-gallery" data-testid="play-gallery"><header className="play-gallery-heading"><span className="play-postmark" aria-hidden="true">✳</span><p>留一扇门，给有趣的人。</p><h1>朋友来了，<br />想一起玩点什么？</h1><span>一条链接，一点共同背景。把你的 AI 搭子也带上。</span></header>
      <div className="play-case-list">{(Object.entries(playCases) as [PlayTemplate, typeof playCases[PlayTemplate]][]).map(([id, item]) => <button className={`play-case play-case-${id}`} key={id} data-testid={`play-case-${id}`} onClick={() => choose(id)}><div className="play-case-art" aria-hidden="true"><span>{item.mark}</span>{id === 'travel' ? <div className="play-route-dots"><i /><i /><i /></div> : id === 'project' ? <span className="play-paper-note">有个点子！</span> : <span className="play-speech">嗨，进来坐坐。</span>}</div><div className="play-case-copy"><small>{item.tag}</small><h2>{item.title}</h2><p>{item.subtitle}</p><span>就玩这个 <Sparkles size={15} /></span></div></button>)}</div>
      {rooms.length > 0 && <section className="play-existing"><h3>上次的故事，还能接着聊。</h3>{rooms.map(r => <button key={r.id} data-testid={`play-open-${r.id}`} onClick={() => { setError(''); void api<PlayRoom>(`/playrooms/${r.id}`).then(value => { setInvitation(null); setRoom(value); }).catch(e => setError(playError(e))); }}><span>{playCases[r.template].mark}</span><strong>{r.title}</strong><small>{r.closed ? '已结束 · 查看留下的内容' : `${r.participantCount} 位伙伴`}</small></button>)}</section>}
    </div>}{error && <p className="play-error" role="alert">{error}</p>}
  </div></Modal>;
}
