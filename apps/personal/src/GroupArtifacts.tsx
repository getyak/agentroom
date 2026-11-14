import { useEffect, useRef, useState } from 'react';
import { Check, FileText, Gamepad2, Plus, Vote } from 'lucide-react';
import type { GroupArtifact, GroupArtifactAction } from './group-types';
const key = () => crypto.randomUUID();
type Props = { artifacts: GroupArtifact[]; onAction: (body: GroupArtifactAction) => Promise<GroupArtifact>; disabled?: boolean };
function Note({ artifact, onAction, disabled }: { artifact: GroupArtifact } & Omit<Props, 'artifacts'>) {
  const [draft, setDraft] = useState(artifact.text), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const base = useRef(artifact), currentDraft = useRef(draft); currentDraft.current = draft;
  useEffect(() => { if (!dirty) { base.current = artifact; setDraft(artifact.text); } }, [artifact.revisionId, artifact.text, dirty]);
  const save = async () => {
    if (busy || disabled) return; setBusy(true); setError(''); const sent = draft;
    try { const result = await onAction({ action: 'edit', artifactId: artifact.id, revisionId: base.current.revisionId, hash: base.current.hash, text: sent, clientId: key() }); base.current = result; if (currentDraft.current === sent) setDirty(false); }
    catch (e) { setError(e instanceof Error ? e.message : '没有保存，草稿还在'); } finally { setBusy(false); }
  };
  return <article className="group-work group-note"><header><FileText size={18} /><strong>{artifact.title}</strong><span>共同便笺</span></header>
    <textarea aria-label={artifact.title} data-testid={`group-note-${artifact.id}`} value={draft} maxLength={12000} disabled={disabled} onChange={e => { if (!dirty) base.current = artifact; setDirty(true); setDraft(e.target.value); }} />
    <footer><small>{dirty ? '草稿还没保存' : '已保存为作品版本'}</small><button data-testid={`group-note-save-${artifact.id}`} disabled={!dirty || busy || disabled} onClick={() => void save()}><Check size={14} />{busy ? '正在保存…' : '保存便笺'}</button></footer>
    {error && <div className="group-error" role="alert">{error}<button onClick={() => { base.current = artifact; setError('已读取最新版本。请对照下方内容合并你的草稿。'); }}>对照最新版本</button><pre>{artifact.text}</pre></div>}
  </article>;
}
export function GroupArtifacts({ artifacts, onAction, disabled }: Props) {
  const [creating, setCreating] = useState(false), [kind, setKind] = useState('note'), [title, setTitle] = useState('一起写点什么'), [text, setText] = useState(''), [choices, setChoices] = useState('带相机随便走走\n找一家海边小店\n坐着发呆到日落');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const pending = useRef<{ hash: string; clientId: string } | null>(null);
  const create = async () => {
    if (busy) return; setBusy(true); setError(''); const input = { kind, title, text, ...(kind !== 'note' ? { choices: choices.split('\n').map(s => s.trim()).filter(Boolean) } : {}) }, hash = JSON.stringify(input);
    if (pending.current?.hash !== hash) pending.current = { hash, clientId: key() };
    try { await onAction({ action: 'create', ...input, clientId: pending.current.clientId }); pending.current = null; setCreating(false); }
    catch (e) { setError(e instanceof Error ? e.message : '作品还没创建'); } finally { setBusy(false); }
  };
  const choose = async (artifact: GroupArtifact, choiceId: string) => { if (busy || disabled) return; setBusy(true); setError(''); try { await onAction({ action: 'act', artifactId: artifact.id, revisionId: artifact.revisionId, choiceId, clientId: key() }); } catch (e) { setError(e instanceof Error ? e.message : '选择没有保存'); } finally { setBusy(false); } };
  return <section className="group-artifacts" data-testid="group-artifacts"><div className="group-section-heading"><div><h3>把聊天变成一点东西</h3><p>一起写、一人一票，或者测一测默契。</p></div><button aria-expanded={creating} disabled={disabled} onClick={() => setCreating(!creating)}><Plus size={17} />新作品</button></div>
    <div className="group-artifact-kinds">{([['note', FileText, '便笺'], ['poll', Vote, '一起决定'], ['quiz', Gamepad2, '默契竞猜']] as const).map(([value, Icon, label]) => <button key={value} data-testid={`group-artifact-${value}`} disabled={disabled} onClick={() => { setKind(value); setTitle(value === 'note' ? '一起写点什么' : value === 'poll' ? '大家更想做什么？' : '猜猜大家会选哪一个？'); setCreating(true); }}><Icon size={17} />{label}</button>)}</div>
    {creating && <form className="group-artifact-form" onSubmit={e => { e.preventDefault(); void create(); }}><label>作品名字<input data-testid="group-artifact-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={120} required /></label><label>{kind === 'note' ? '先写下第一笔' : '怎么玩'}<textarea data-testid="group-artifact-text" value={text} onChange={e => setText(e.target.value)} maxLength={12000} /></label>{kind !== 'note' && <label>选项，每行一个<textarea value={choices} onChange={e => setChoices(e.target.value)} maxLength={600} /></label>}<button className="im-primary" data-testid="group-artifact-create" disabled={busy || disabled || !title.trim()}>{busy ? '正在创建…' : '放进群里'}</button></form>}
    {error && <p className="group-error" role="alert">{error}</p>}
    <div className="group-works">{artifacts.map(artifact => artifact.kind === 'note' ? <Note key={artifact.id} artifact={artifact} onAction={onAction} disabled={disabled} /> : <article className={`group-work group-activity group-${artifact.kind}`} key={artifact.id}><header><Gamepad2 size={18} /><strong>{artifact.title}</strong><span>{artifact.kind === 'quiz' ? '默契竞猜' : '一起决定'}</span></header>{artifact.text && <p>{artifact.text}</p>}{artifact.kind === 'quiz' && <small>先猜大家会选什么，再看看默契有多高。</small>}<div className="group-choices">{artifact.choices?.map(choice => <button key={choice.id} data-testid={`group-choice-${artifact.id}-${choice.id}`} aria-pressed={artifact.myChoice === choice.id} disabled={busy || disabled} onClick={() => void choose(artifact, choice.id)}><span>{choice.label}</span><b>{choice.votes.length}</b>{artifact.myChoice === choice.id && <Check size={15} />}</button>)}</div></article>)}</div>
    {!artifacts.length && !creating && <p className="group-empty">旅行清单、分身的自我介绍、项目第一稿，都可以从一张便笺开始。</p>}
  </section>;
}
