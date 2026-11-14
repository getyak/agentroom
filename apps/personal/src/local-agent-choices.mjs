/** Project inventory facts without probing providers or ranking model intelligence. */
export function localAgentChoices(inventory, contacts, recentContactIds = []) {
  return (inventory?.agents || []).filter(agent => agent.installed).map(agent => {
    const contact = contacts.find(person => person.id === `agent_${agent.id}` && person.binding?.type === 'local' && person.binding.localAgentId === agent.id);
    const supported = agent.execution?.supported === true;
    const acp = agent.execution?.protocol === 'acp';
    const ready = supported && (agent.auth?.status === 'configured' || acp && agent.auth?.status === 'unknown') && contact?.availability === 'ready' && !contact.configurationError;
    const state = !supported ? 'unsupported' : ready ? 'ready' : 'setup';
    const status = !supported ? '已发现，暂不支持聊天'
      : contact?.configurationError || contact?.availability === 'configuration_required' ? '需要完善模型配置'
      : agent.auth?.status === 'required' ? '需要登录'
      : acp && agent.auth?.status === 'unknown' ? '可连接 · 登录由原助手管理'
      : agent.auth?.status !== 'configured' ? '登录状态待检查'
      : ready ? '已检测到登录配置' : '需要重新检查配置';
    const recent = contact ? recentContactIds.indexOf(contact.id) : -1;
    return { agent, contact, state, status, added: Boolean(contact && contact.added !== false), reason: ready && recent >= 0 ? '最近聊过' : '', recent };
  }).sort((a, b) => {
    const rank = { ready: 0, setup: 1, unsupported: 2 };
    return rank[a.state] - rank[b.state]
      || (a.recent < 0 ? Infinity : a.recent) - (b.recent < 0 ? Infinity : b.recent)
      || a.agent.name.localeCompare(b.agent.name, 'zh-CN') || a.agent.id.localeCompare(b.agent.id);
  });
}
