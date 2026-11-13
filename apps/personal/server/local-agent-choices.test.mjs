import test from 'node:test';
import assert from 'node:assert/strict';
import { localAgentChoices } from '../src/local-agent-choices.mjs';

const agent = (id, extra = {}) => ({ id, name: id, installed: true, auth: { status: 'configured' }, execution: { supported: true }, ...extra });
const contact = (id, extra = {}) => ({ id: `agent_${id}`, kind: 'agent', name: id, added: false, availability: 'ready', binding: { type: 'local', localAgentId: id }, ...extra });

test('ready environments precede setup and unsupported entries without a brand preference', () => {
  const inventory = { agents: [agent('codex', { auth: { status: 'required' } }), agent('pi'), agent('claude'), agent('gemini', { execution: { supported: false } }), agent('opencode', { installed: false })] };
  const contacts = [contact('codex', { availability: 'login_required' }), contact('pi'), contact('claude'), contact('gemini', { availability: 'unsupported' })];
  const before = JSON.stringify({ inventory, contacts });
  const choices = localAgentChoices(inventory, contacts, ['agent_codex', 'agent_pi']);
  assert.deepEqual(choices.map(c => c.agent.id), ['pi', 'claude', 'codex', 'gemini']);
  assert.deepEqual(choices.map(c => c.state), ['ready', 'ready', 'setup', 'unsupported']);
  assert.equal(choices[0].reason, '最近聊过');
  assert.equal(JSON.stringify({ inventory, contacts }), before);
});

test('configuration errors and unknown authentication cannot become a one-click chat', () => {
  const choices = localAgentChoices({ agents: [agent('pi'), agent('codex', { auth: { status: 'unknown' } })] }, [contact('pi', { availability: 'configuration_required', configurationError: 'model unavailable' }), contact('codex')]);
  assert.ok(choices.every(c => c.state === 'setup'));
  assert.equal(choices.find(c => c.agent.id === 'pi').status, '需要完善模型配置');
  assert.equal(choices.find(c => c.agent.id === 'codex').status, '登录状态待检查');
});

test('stable contacts preserve custom names and adoption; incomplete discovery is not ready', () => {
  const saved = contact('claude', { name: '我的伙伴', added: true });
  const [choice] = localAgentChoices({ agents: [agent('claude')] }, [saved]);
  assert.equal(choice.contact, saved);
  assert.equal(choice.added, true);
  assert.equal(choice.status, '已检测到登录配置');
  assert.equal(localAgentChoices({ agents: [agent('pi')] }, [])[0].state, 'setup');
  assert.deepEqual(localAgentChoices(null, []), []);
});
