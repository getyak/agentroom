import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Compass, FolderOpen, Link2, Loader2, RefreshCw, Users, X } from 'lucide-react';
import { api, key } from './api';
import { desktopBridge } from './native';
import { AgentOptions } from './AgentOptions';
import type { AgentConfiguration } from './types';
import type { RoomieState, RoomieCard } from './roomie-types';
import './roomie.css';
const phases:Record<string,string>={queued:'正在排队',probing:'正在真实测试连接',analyzing:'正在准备适合你的伙伴',completed:'配置建议已就绪',failed:'配置未完成',interrupted:'上次准备已中断',cancelled:'已停止'};
const running=(s:RoomieState|null)=>[s?.job,s?.observation].some(job=>job&&['queued','probing','analyzing'].includes(job.status));
/** Configuration tools embedded in Roo's ordinary conversation; no second composer. */
export function RoomieChat({onOpenThread,onConnect,onChanged}:{onOpenThread:(id:string)=>void;onConnect:()=>void;onChanged:()=>Promise<void>}) {
 const [state,setState]=useState<RoomieState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState('');
 const [agentId,setAgentId]=useState(''),[configuration,setConfiguration]=useState<AgentConfiguration>({modelMode:'follow',thinking:'follow'});
 const [resource,setResource]=useState<'project'|'link'|null>(null),[resourceValue,setResourceValue]=useState('');
 const live=useRef(true),requests=useRef(new Map<string,string>()),loading=useRef<Promise<void>|null>(null),refreshEpoch=useRef(0),configurationDirty=useRef(false);
 const refresh=useCallback(async()=>{
  if(loading.current)return loading.current;
  const epoch=refreshEpoch.current;
  const task=(async()=>{
   try{
    const next=await api<RoomieState>('/roomie');
    if(live.current&&epoch===refreshEpoch.current){
     setState(next);
     if(!configurationDirty.current){setAgentId(next.settings.agentId||'');setConfiguration(next.settings.configuration||{modelMode:'follow',thinking:'follow'});}
    }
   }catch(e){if(live.current)setError(e instanceof Error?e.message:'无法读取阿屋配置');}
  })();
  loading.current=task;
  try{await task;}finally{if(loading.current===task)loading.current=null;}
 },[]);
 useEffect(()=>{live.current=true;void refresh();const off=desktopBridge()?.onChanged(()=>void refresh());return()=>{live.current=false;off?.();};},[refresh]);
 useEffect(()=>{const timer=window.setInterval(()=>{if(!document.hidden)void refresh();},running(state)?1500:60000);return()=>window.clearInterval(timer);},[refresh,state?.job?.status,state?.observation?.status]);
 const selected=state?.agents.find(a=>a.id===agentId),active=running(state);
 const perform=async(name:string,path:string,body:Record<string,unknown>)=>{
  if(busy)return;setBusy(name);setError('');const signature=JSON.stringify([path,body]);const clientId=requests.current.get(signature)||key();requests.current.set(signature,clientId);
  try{const result=await api<{threadId?:string;contactId?:string}>(path,{...body,clientId});requests.current.delete(signature);if(name==='select_backend'){refreshEpoch.current++;await loading.current;configurationDirty.current=false;}await refresh();await onChanged();return result;}
  catch(e){if(live.current)setError(e instanceof Error?e.message:'操作尚未完成，可以重试');}
  finally{if(live.current)setBusy('');}
 };
 const action=(action:string,extra:Record<string,unknown>={})=>perform(action,'/roomie/actions',{action,...extra});
 const openContact=async(contactId:string)=>{const chat=await perform('open','/chats',{kind:'direct',memberIds:[contactId]});if(chat?.threadId)onOpenThread(chat.threadId);else if(chat&&(chat as unknown as {id?:string}).id)onOpenThread((chat as unknown as {id:string}).id);};
 const card=(item:RoomieCard)=><article key={item.id} className="roomie-card" data-testid={`roomie-${item.kind}-card`}><div className="roomie-card-heading"><span className="roomie-card-icon">{item.kind==='group'?<Users size={21}/>:<Compass size={21}/>}</span><div><strong>{item.title}</strong><small>{item.kind==='group'?'话题群建议':item.kind==='role'?'联系人申请':item.kind==='existing'?'已有联系人':'本机发现'}</small></div><button className="im-icon" aria-label={`忽略${item.title}`} data-testid="roomie-dismiss" disabled={Boolean(busy)} onClick={()=>void action('dismiss',{recommendationId:item.id})}><X size={14}/></button></div><p>{item.description}</p>{item.rationale&&<small className="roomie-card-reason">{item.source==='starter_template'?'通用模板 · ':''}{item.rationale}</small>}{item.memberNames&&<p className="roomie-member-names">成员：{item.memberNames.join('、')} · 仅本机私有群</p>}
  {item.kind==='local'?<button className="im-secondary" data-testid={`roomie-add-local-${item.agentId}`} disabled={Boolean(busy)||active} onClick={()=>item.canTest?void action('add_local',{agentId:item.agentId,...(item.agentId===agentId?{configuration}:{})}):onConnect()}>{busy==='add_local'?<Loader2 size={15} className="working"/>:null}{item.canTest?'添加并完成配置':'检查登录与配置'}<ChevronRight size={15}/></button>
  :item.kind==='role'?<button className="im-secondary" data-testid="roomie-add-role" disabled={Boolean(busy)} onClick={()=>item.contactId?void openContact(item.contactId):void action('add_role',{recommendationId:item.id,jobId:item.jobId})}>{item.contactId?<><Check size={15}/>已添加 · 开始聊天</>:'添加联系人'}<ChevronRight size={15}/></button>
  :item.kind==='group'?<button className="im-secondary" data-testid="roomie-create-group" disabled={Boolean(busy)} onClick={()=>item.threadId?onOpenThread(item.threadId):void action('create_group',{recommendationId:item.id,jobId:item.jobId})}>{item.threadId?'打开群聊':'创建群聊并配好成员'}<ChevronRight size={15}/></button>
  :<button className="im-secondary" data-testid="roomie-open-existing" disabled={Boolean(busy)} onClick={()=>void openContact(item.contactId!)}>打开聊天<ChevronRight size={15}/></button>}</article>;
 return <section className="roomie-settings" data-testid="roomie-chat">
  <div className="roomie-settings-heading"><strong>项目与伙伴配置</strong><button className="im-icon" data-testid="roomie-refresh" aria-label="检查本机配置" onClick={()=>void refresh()}><RefreshCw size={18}/></button></div>
  {!state&&<p role="status">正在读取配置…</p>}
  <details className="roomie-backend-options"><summary data-testid="roomie-model-options">{selected?`对话助手：${selected.name}`:'尚未找到可用的对话助手'}<ChevronRight size={13}/></summary><label>阿屋使用的本机助手<select data-testid="roomie-backend" value={agentId} disabled={active||Boolean(busy)} onChange={e=>{const next=e.target.value;configurationDirty.current=true;setAgentId(next);setConfiguration({modelMode:'follow',thinking:'follow'});}}><option value="" disabled>自动发现本机可用助手</option>{state?.agents.map(a=><option key={a.id} value={a.id} disabled={!a.executionSupported||a.authStatus!=='configured'}>{a.name}{!a.executionSupported?' · 暂不支持聊天':a.authStatus!=='configured'?' · 需要登录':''}</option>)}</select></label>{selected?.profile&&<fieldset className="roomie-model-fields" disabled={active||Boolean(busy)}><AgentOptions profile={selected.profile} value={configuration} onChange={value=>{configurationDirty.current=true;setConfiguration(value);}} refreshing={active} onRefresh={()=>void refresh()}/></fieldset>}<button className="im-secondary" data-testid="roomie-save-backend" disabled={!selected||active||Boolean(busy)} onClick={()=>void action('select_backend',{agentId,configuration})}>保存对话配置</button><p>使用本机已有登录和模型配置。切换后接着聊，历史消息和已接受的任务保留原配置。</p></details>
  <div className="roomie-choice-card"><strong>围绕这段对话准备伙伴</strong><p>先在下面的消息框告诉阿屋你的目标，再准备联系人和群聊建议。只有你点击采用才会创建。</p><button className="im-secondary" data-testid="roomie-prepare" disabled={!selected?.planningSupported||active||Boolean(busy)} onClick={()=>void action('prepare',{agentId,configuration})}>准备伙伴与群聊建议<ChevronRight size={15}/></button>{selected&&!selected.planningSupported&&<p>当前助手可以正常聊天；准备伙伴建议需要在上方选择支持此操作的助手。</p>}</div>
   {state?.job&&<div className={`roomie-progress ${state.job.status==='failed'?'attention':''}`} data-testid="roomie-status" role="status">{active?<Loader2 size={16} className="working"/>:state.job.probe.status==='passed'?<Check size={16}/>:null}<div><strong>{phases[state.job.status]||state.job.status}</strong>{state.job.error&&<p>{state.job.error}</p>}{state.job.probe.testedAt&&<small>真实测试于 {new Date(state.job.probe.testedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</small>}</div>{state.job.stopUnconfirmed&&<button className="im-text-button" data-testid="roomie-reconcile" disabled={Boolean(busy)} onClick={()=>void action('reconcile',{jobId:state.job!.id})}>核查停止状态</button>}{active&&<button className="im-text-button" data-testid="roomie-cancel" disabled={Boolean(busy)} onClick={()=>void action('cancel',{jobId:state.job!.id})}>停止</button>}</div>}
   {state&&<div className="roomie-recommendations" data-testid="roomie-recommendations">{state.recommendations.map(card)}</div>}
   {state&&!state.agents.some(a=>a.executionSupported&&a.authStatus==='configured'&&a.execution)&&<div className="roomie-choice-card" data-testid="roomie-no-backend"><strong>没有找到可用的本机对话助手。</strong><p>请在本机登录 Codex、Claude 或 Gemini 后重新检查。目录和链接可以先保存。</p><button className="im-secondary" onClick={onConnect}>连接或登录助手<ChevronRight size={15}/></button></div>}
   {state?.job?.status==='completed'&&!state.settings.monitor&&!state.settings.monitorGuidanceDone&&<div className="roomie-choice-card" data-testid="roomie-monitor-guidance"><strong>以后也让我留意这台 Mac 的配置变化？</strong><p>发现新助手、登录失效或模型配置变化时，我会给你新的选项。只检查已支持的本机配置，不会自动调用模型。</p><div><button data-testid="roomie-monitor-enable" onClick={()=>void action('monitor',{enabled:true})}>开启主动发现<ChevronRight size={15}/></button><button data-testid="roomie-monitor-later" onClick={()=>void action('monitor',{enabled:false})}>先手动检查</button></div></div>}
   {state&&<details className="roomie-resources" data-testid="roomie-resources"><summary><FolderOpen size={16}/> 工作目录、链接与主动推荐</summary><p>项目目录仅在你选择的范围内读取；之后添加的新伙伴和新群沿用这个项目，已有绑定保持原目录。不同接入的实际读取能力会分别核对。</p>
    {state.projects.map(project=><div className="roomie-resource-row" key={project.id}><FolderOpen size={16}/><span>{project.name}<small>{project.root}</small></span><span>{state.settings.projectId===project.id?'当前项目':'已保存'}</span></div>)}
    {state.settings.projectId&&state.job?.status==='completed'&&state.recommendations.some(r=>r.contactId||r.threadId)&&<div className="roomie-choice-card"><p>也可以把当前目录应用到本轮已添加的伙伴与私有群：{state.recommendations.filter(r=>r.kind==='role'&&r.contactId||r.kind==='group'&&r.threadId).map(r=>r.title).join('、')}。这会授权列出的成员读取当前目录。</p><button className="im-secondary" data-testid="roomie-apply-project" disabled={Boolean(busy)} onClick={()=>void action('apply_project',{jobId:state.job!.id})}>应用到这些伙伴和群</button></div>}
    <button className="im-text-button" data-testid="roomie-project-choose" disabled={Boolean(busy)} onClick={()=>{const choose=desktopBridge()?.chooseProject;if(choose){setBusy('project');void choose().then(()=>refresh()).catch(e=>setError(String(e))).finally(()=>setBusy(''));}else{setResource('project');setResourceValue('');}}}><FolderOpen size={15}/>选择工作目录</button>
    {state.links.map(link=><div className="roomie-resource-row" key={link.id}><Link2 size={16}/><a href={link.url} target="_blank" rel="noreferrer noopener">{link.label}</a></div>)}
    <button className="im-text-button" data-testid="roomie-link-add" onClick={()=>{setResource('link');setResourceValue('');}}><Link2 size={15}/>添加资料链接</button>
    {resource&&<form className="roomie-resource-form" onSubmit={event=>{event.preventDefault();void perform('resource',resource==='project'?'/roomie/projects':'/roomie/links',resource==='project'?{path:resourceValue}:{url:resourceValue}).then(result=>{if(result)setResource(null);});}}><label>{resource==='project'?'本机项目的绝对路径':'网页、文档或仓库链接'}<input data-testid="roomie-resource-input" value={resourceValue} onChange={e=>setResourceValue(e.target.value)} placeholder={resource==='project'?'/Users/…/my-project':'https://…'}/></label><button className="im-secondary" data-testid="roomie-resource-save" disabled={!resourceValue.trim()||Boolean(busy)}>保存</button></form>}
    <label className="roomie-toggle"><input type="checkbox" data-testid="roomie-monitor" checked={state.settings.monitor} onChange={e=>{const enabled=e.target.checked;setState(current=>current?{...current,settings:{...current.settings,monitor:enabled}}:current);void action('monitor',{enabled}).then(()=>refresh());}} disabled={Boolean(busy)}/><span>留意本机助手和配置的变化<small>仅检查已支持的配置位置；有变化再推荐，不自动运行模型。</small></span></label>
    <label className="roomie-toggle"><input type="checkbox" data-testid="roomie-proactive" checked={Boolean(state.settings.proactive)} onChange={e=>{const enabled=e.target.checked;setState(current=>current?{...current,settings:{...current.settings,proactive:enabled}}:current);void action('proactive',{enabled}).then(()=>refresh());}} disabled={Boolean(busy)}/><span>结合群聊与环境，主动给我建议<small>允许阿屋按需调用当前模型，读取我和它共同可见的群消息及本机配置。变化后分析，至少间隔五分钟；没有值得提醒的事就保持安静。不会自动建群或添加伙伴。</small></span></label>
    {state.settings.proactive&&!selected?.planningSupported&&<p data-testid="roomie-proactive-unsupported">当前助手支持普通聊天，主动理解需要选择支持隔离工具的 Codex 或 Pi。</p>}
    {state.settings.proactiveError&&<p className="im-error" role="status">主动检查暂未开始：{state.settings.proactiveError}</p>}
    {state.observation&&<div className="roomie-progress" data-testid="roomie-observation-status" role="status"><div><strong>{['queued','probing','analyzing'].includes(state.observation.status)?'正在理解群聊与环境':state.observation.status==='completed'?'本轮理解已完成':state.observation.status==='cancelled'?'主动理解已停止':'本轮理解未完成'}</strong>{state.observation.error&&<p>{state.observation.error}</p>}{state.observation.sampledAt&&<small>采样于 {new Date(state.observation.sampledAt).toLocaleString('zh-CN')}</small>}</div>{['queued','probing','analyzing'].includes(state.observation.status)&&<button className="im-text-button" data-testid="roomie-observation-cancel" disabled={Boolean(busy)} onClick={()=>void action('cancel',{jobId:state.observation!.id})}>停止本轮</button>}{state.observation.stopUnconfirmed&&<button className="im-text-button" data-testid="roomie-observation-reconcile" disabled={Boolean(busy)} onClick={()=>void action('reconcile',{jobId:state.observation!.id})}>核查停止状态</button>}</div>}
   </details>}
  {error&&<p className="im-error" data-testid="roomie-error" role="alert">{error}</p>}
 </section>;
}
