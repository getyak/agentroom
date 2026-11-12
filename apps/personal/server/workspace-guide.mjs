import * as os from 'node:os';
import { resolveExecution } from './agent-profiles.mjs';
import { id, now } from './store.mjs';

const GUIDE = 'agentroom_guide';
const NAME = '阿屋 Roo';
const clean = (value, max = 100) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
const instructions = '你是阿屋 Roo，AgentRoom 的向导，也是用户的第一位伙伴。用自然、简短的中文陪用户认识这台电脑、已有助手和联系人。根据提供的 guide 事实解释配置与下一步，未知就直说。引导卡提供发现环境、添加本机助手、连接账号、角色建议和其他设备入口。只有用户明确采用才创建联系人；只有产品回执才能证明申请已发送或连接已完成。检测到配置不等于实际运行成功。不索取密码，不读取凭据、无关文件或其他私聊。';

/** Bounded projection for an accepted guide DM; never raw files, URLs or transcripts. */
export function guideContext(store) {
  const contacts = store.list('contact');
  return { sampledAt: now(), executionVerified: false,
    host: { platform: os.platform(), architecture: os.arch(), totalMemoryGiB: Math.floor(os.totalmem() / 1024 ** 3) },
    agents: contacts.filter(c => c.discovered && c.binding?.type === 'local').slice(0, 5).map(c => ({
      id: c.binding.localAgentId, name: clean(c.name, 80), availability: c.availability,
      provider: clean(c.profile?.defaults?.provider), model: clean(c.profile?.defaults?.model), thinking: clean(c.profile?.defaults?.thinking, 30),
    })),
    contacts: contacts.filter(c => c.id !== 'self' && c.id !== GUIDE && c.added !== false).slice(0, 40).map(c => ({ id: c.id, name: clean(c.name, 80), kind: c.kind, handle: clean(c.handle, 32) })),
    connections: store.list('connection').slice(0, 20).map(c => ({ id: c.id, name: clean(c.name, 80), protocol: c.type === 'mcp' ? 'mcp' : 'a2a' })),
    actions: ['发现本机环境', '添加本机助手', '连接账号与其他设备', '让助手建议角色'],
  };
}

export class WorkspaceGuide {
  constructor(store, messenger) { this.store = store; this.messenger = messenger; }

  sync(detected) {
    return this.store.transaction(() => this.synchronize(detected));
  }

  synchronize(detected) {
    let state = this.store.get('setting', 'workspace-guide');
    if (!state && this.store.get('setting', 'workspace-onboarding')?.completed) return null;
    let contact = this.store.get('contact', GUIDE);
    if (!contact) {
      const handles = new Set(this.store.list('contact').map(c => c.handle));
      let handle = 'roo';
      for (let suffix = 2; handles.has(handle); suffix++) handle = `roo-${suffix}`;
      contact = this.store.put('contact', { id: GUIDE, kind: 'agent', systemRole: 'guide', name: NAME, handle,
        description: '你的房间向导，陪你认识这台电脑上的伙伴。', instructions, color: 'teal', icon: 'auto', avatar: null,
        binding: null, configuration: { modelMode: 'follow', thinking: 'follow' }, added: true, version: 1, createdAt: now(),
        availability: 'disconnected', availabilityReason: '先连接一位本机助手，阿屋就能和你聊天。' });
    }
    // Bind once. Authentication/configuration changes never trigger provider switching.
    if (!contact.binding) {
      const preferred = this.store.get('setting', 'local-agent')?.agentId;
      const order = [...new Set([preferred, 'codex', 'claude', 'pi'])].filter(Boolean);
      const selected = order.map(key => detected.agents.find(a => a.id === key)).find(a => {
        if (!a?.installed || !a.execution?.supported || a.auth?.status !== 'configured' || !a.profile) return false;
        try { resolveExecution(a.profile); return true; } catch { return false; }
      });
      if (selected) contact = this.store.put('contact', { ...contact, binding: { type: 'local', localAgentId: selected.id },
        availabilityReason: '', version: contact.version + 1, updatedAt: now() });
    }
    const agentId = contact.binding?.localAgentId || null;
    const providerName = agentId ? clean(detected.agents.find(a => a.id === agentId)?.name) || agentId : null;
    const reason = agentId ? `已选择 ${providerName}：本机已安装、已检测到登录配置，模型设置有效。首次发送时会核对实际运行；后续不会自动更换助手。`
      : '还没有找到可用的本机聊天助手。先连接并登录 Codex、Claude Code 或 Pi；你现在也可以查看环境和添加联系人。';
    if (!state) {
      // Save the onboarding flag so a restart does not mistake Roo for an old workspace.
      if (!this.store.get('setting', 'workspace-onboarding')) this.store.put('setting', { id: 'workspace-onboarding', completed: false });
      const thread = this.messenger.createChat({ kind: 'direct', memberIds: [GUIDE] });
      thread.messages.push({ id: id('msg'), role: 'assistant', contactId: GUIDE,
        contactSnapshot: { id: GUIDE, kind: 'agent', systemRole: 'guide', name: NAME, color: 'teal', avatar: null },
        text: '嗨，我是阿屋 Roo，先陪你把这个房间安顿好。\n\n你想先认识这台电脑上的助手，还是连接一位已有的伙伴？下面的引导卡可以带你开始。',
        attachments: [], createdAt: now(), recipientIds: ['self', GUIDE] });
      thread.summary = '认识环境，找到你的第一位伙伴';
      this.store.put('thread', thread);
      state = { id: 'workspace-guide', contactId: GUIDE, threadId: thread.id, createdAt: now() };
    }
    const next = { ...state, agentId, providerName, reason, executionVerified: false };
    if (JSON.stringify(state) !== JSON.stringify(next)) this.store.put('setting', next);
    return this.state();
  }

  state() {
    const state = this.store.get('setting', 'workspace-guide');
    if (!state) return null;
    const { id: _id, ...publicState } = state;
    return publicState;
  }
}
