import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolSessions } from './tool-sessions.mjs';
import { executeLocalAgent } from './local-agents.mjs';
import { guestCodexSession } from './play-executor.mjs';
import { APIError } from './store.mjs';
const tools=[{name:'roomie_context',description:'Read only the owner-selected setup metadata. No other files, accounts, tools or conversations are available.',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
/** Same restricted transport as invitation rooms; no inherited MCP, skills or shell. */
export function createRoomieExecutor(store, options={}) {
 const broker=new ToolSessions();
 return {
  async execute(request) {
   if(!['codex','pi'].includes(request.id))throw new APIError(409,'roomie_adapter_unsupported','这个助手可以聊天，但暂不支持隔离的工作区配置。请使用本机 Codex 或 Pi。');
   const workspace=join(store.dataDir,'workspaces',request.runId);await mkdir(workspace,{recursive:true,mode:0o700});
   await broker.listen();const session=broker.open({},tools,()=>request.context,{validate:(_c,_n,args)=>{if(Object.keys(args).length)throw new Error('Context has no arguments');},retainResult:()=>false});
   let isolated;
   try {
    if(request.id==='codex')isolated=await guestCodexSession(workspace,options.deps);
    return await (options.execute||executeLocalAgent)({...request,workspace,toolSession:session,isolateUserContext:true,deps:{...(isolated?.deps||options.deps),executionTimeoutMs:120000,maxOutputBytes:200000}});
   } finally {session.close();await isolated?.close();}
  },
  close:()=>broker.close(),
 };
}
