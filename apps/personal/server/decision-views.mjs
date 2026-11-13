// Public projections contain no credential binding or dispatch authority.
export function decisionView(store, decision, clock = Date.now) {
  const provider = decision.kind === 'provider_approval';
  const authority = decision.authority || (provider ? 'provider' : 'agentroom');
  const grant = decision.grantId ? store.get('decision_grant', decision.grantId) : null;
  const grantState = grant ? grant.state === 'revoked' ? 'revoked' : grant.expiresAt <= clock() ? 'expired' : grant.used >= grant.maxUses ? 'exhausted' : 'active' : null;
  return { ...decision, requestType: decision.requestType || (provider ? 'choice' : 'authorization'), authority,
    ...(provider ? { actionState: 'not_observed', verificationState: 'not_provided' } : {}),
    capabilities: { response: authority === 'original_app_only' ? 'original_app' : 'agentroom',
      authorization: provider ? 'provider_gate' : 'local_gate',
      canRepeat: !provider && decision.operationType === 'mcp' && Boolean(decision.schemaFingerprint),
      cancellation: 'request_only', retry: provider ? 'reconcile_only' : 'never' },
    ...(grant ? { authorization: { kind: 'conversation_exact', state: grantState, grantId: grant.id,
      expiresAt: new Date(grant.expiresAt).toISOString(), remaining: Math.max(0, grant.maxUses - grant.used), maxUses: grant.maxUses,
      scope: '当前对话中的相同工具、相同参数和读回，最多 1 小时、10 次操作' } } : {}),
    facts: {
      interaction: decision.state,
      response: decision.deliveryState || 'not_sent',
      execution: provider ? 'not_observed' : decision.actionState || 'not_started',
      verification: provider ? 'not_provided' : decision.verificationState || 'not_provided',
      verificationScope: provider ? null : decision.verificationScope || null,
      localArtifactVerification: provider ? 'not_provided' : decision.localArtifactVerification || 'not_provided',
    } };
}

export function decisionThread(store, thread, clock = Date.now) {
  return { ...thread, decisions: thread.decisions.map(decision => decisionView(store, decision, clock)) };
}
