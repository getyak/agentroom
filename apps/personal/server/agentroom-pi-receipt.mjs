import { digest } from './store.mjs';
import { completedPiTurn } from './conversation-pi.mjs';

// Explicit trusted extension. Custom entries are private metadata, never model messages.
export default function agentRoomReceipt(pi) {
  const runId=process.env.AGENTROOM_CONVERSATION_RUN,payloadHash=process.env.AGENTROOM_CONVERSATION_HASH;
  const provider=process.env.AGENTROOM_CONVERSATION_PROVIDER,model=process.env.AGENTROOM_CONVERSATION_MODEL;
  let startId;
  pi.on('session_before_compact',()=>({cancel:true}));
  pi.on('before_agent_start',(event,ctx)=>{
    if(!runId || !payloadHash || startId || digest(event.prompt)!==payloadHash)throw new Error('AgentRoom input receipt mismatch');
    pi.appendEntry('agentroom_turn_started',{schema:1,runId,payloadHash});startId=ctx.sessionManager.getLeafId();
  });
  pi.on('agent_settled',(_event,ctx)=>{
    if(!startId || !ctx.isIdle() || ctx.model?.provider!==provider || ctx.model?.id!==model)return;
    const proof=completedPiTurn(ctx.sessionManager.getBranch(),startId,{runId,payloadHash,provider,model,sessionId:ctx.sessionManager.getSessionId()});
    if(proof)pi.appendEntry('agentroom_turn_completed',proof);
  });
}
