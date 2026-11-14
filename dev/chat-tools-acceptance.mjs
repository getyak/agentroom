// Isolated synthetic browser acceptance. No provider or private account is called.
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium } = createRequire(require.resolve('@playwright/test'))('playwright');
const { expect } = require('@playwright/test');
const output = resolve(process.env.AGENTROOM_CHAT_TOOLS_EVIDENCE_DIR || 'output/playwright/chat-tools');
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(join(output, 'isolated-'));
let peerId, browser, directoryCallId = 0;
const checks = [], errors = [], directoryCalls = [];
const app = await createPersonalServer({ dataDir, port: 0, staticDir: resolve('apps/personal/dist'), codexCommand: process.execPath,
  discoverLocalAgents: async () => ({ agents: [{ id: 'codex', name: 'Codex', installed: true, auth: { status: 'configured' }, execution: { supported: true } }] }),
  executeLocalAgent: async request => {
    const context = JSON.parse(request.prompt.split('<untrusted_thread_context>\n')[1].split('\n</untrusted_thread_context>')[0]);
    if (context.messages.find(message => message.id === context.currentMessageId)?.text.includes('DIRECTORY_LOOKUP')) {
      const call = async (name, args) => {
        const response = await fetch(request.toolSession.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${request.toolSession.token}` }, body: JSON.stringify({ name, arguments: args, callId: `directory-${++directoryCallId}` }) });
        const body = await response.json(); return { status: response.status, result: body.result };
      };
      const listing = await call('list_rooms', { query: '目录验收' });
      if (listing.status !== 200 || listing.result.rooms.length !== 1) throw new Error('Owned Agent could not discover the unjoined group');
      const room = listing.result.rooms[0], members = await call('get_room_members', { roomId: room.id }), history = await call('read_messages', { roomId: room.id });
      if (members.status !== 200 || members.result.members.length !== 3 || room.joined || room.canReadMessages || history.status !== 403) throw new Error('Directory and history scopes were conflated');
      directoryCalls.push({ listing: listing.result, members: members.result, historyStatus: history.status });
      return { markdown: `${room.name}：${members.result.members.length} 名成员。你尚未加入这个群，能看到群目录，不能读取群消息。`, identity: { id: 'codex', synthetic: true } };
    }
    const response = await fetch(request.toolSession.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${request.toolSession.token}` },
      body: JSON.stringify({ name: 'create_room', arguments: { name: '年底尼泊尔旅行', memberIds: [peerId], text: '大家一起讨论日期、路线和预算。' }, callId: 'browser-create-once' }) });
    if (!response.ok) throw new Error('Synthetic group proposal failed');
    return { markdown: '已准备好建群确认卡，请核对成员后批准。', identity: { id: 'codex', synthetic: true } };
  } });
try {
  await app.listen();
  let serial = 0;
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, clientId: `browser-chat-tools-${++serial}` }) } : {});
    const result = await response.json(); if (!response.ok) throw new Error(result.error?.message); return result;
  };
  await api('/contacts');
  await api('/workspace/onboarding', { action: 'complete', name: '合成验收' });
  const actor = await api('/contacts', { kind: 'agent', name: '旅行规划师', handle: 'trip_planner', binding: { type: 'local', localAgentId: 'codex' } });
  const peer = await api('/contacts', { kind: 'agent', name: '路线研究员', handle: 'researcher', binding: { type: 'local', localAgentId: 'codex' } }); peerId = peer.id;
  const other = await api('/contacts', { kind: 'agent', name: '另一位伙伴', handle: 'other_agent', binding: { type: 'local', localAgentId: 'codex' } });
  const friend = await api('/contacts', { kind: 'human', name: '合成朋友', handle: 'synthetic_friend' });
  const directoryGroup = await api('/chats', { kind: 'group', title: '目录验收共同群', memberIds: [peer.id, friend.id] });
  const chat = await api('/chats', { kind: 'direct', memberIds: [actor.id] });
  const otherChat = await api('/chats', { kind: 'direct', memberIds: [other.id] });
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  for (const target of [chat, otherChat]) {
    await page.goto(`http://127.0.0.1:${app.address().port}/?thread=${target.id}`);
    await page.getByTestId('im-message-input').fill('DIRECTORY_LOOKUP：我有哪些群聊？'); await page.getByTestId('im-send').click();
    await expect(page.getByTestId('im-timeline')).toContainText('目录验收共同群：3 名成员');
    await expect(page.getByTestId('im-timeline')).toContainText('你尚未加入这个群');
  }
  if (directoryCalls.length !== 2 || app.store.require('thread', directoryGroup.id).memberIds.length !== 3) throw new Error('Agent directory verification changed membership');
  checks.push('two independent owned Agents discover an unjoined owner group through real scoped tools without history access');
  await page.screenshot({ path: join(output, 'owned-agent-directory.png') });
  await page.goto(`http://127.0.0.1:${app.address().port}/?thread=${chat.id}`);
  await page.getByTestId('im-message-input').fill('帮我创建旅行群，和路线研究员一起讨论年底尼泊尔旅行。');
  await page.getByTestId('im-send').click();
  const card = page.getByTestId('personal-decision');
  await expect(card).toContainText('旅行规划师申请创建群聊');
  await expect(card).toContainText('路线研究员');
  await expect(card).toContainText('大家一起讨论日期、路线和预算。');
  if (app.store.list('thread').some(t => t.title === '年底尼泊尔旅行')) throw new Error('Room created before approval');
  checks.push('attributed preview and no pre-approval side effect');
  await page.screenshot({ path: join(output, 'pending.png') });
  await card.getByTestId('personal-decision-approve').click();
  await expect(card.getByTestId('personal-chat-action-result')).toContainText('年底尼泊尔旅行');
  await card.getByTestId('personal-chat-action-open').click();
  const group = app.store.list('thread').find(t => t.title === '年底尼泊尔旅行');
  await expect(page).toHaveURL(new RegExp(`thread=${group.id}`));
  await expect(page.getByTestId('im-timeline')).toContainText('大家一起讨论日期、路线和预算。');
  if (group.messages[0].contactId !== actor.id || group.runs.length) throw new Error('Wrong sender or unexpected Agent wake');
  checks.push('approval creates exactly one group and opens attributed first message');
  await page.reload(); await expect(page.getByTestId('im-timeline')).toContainText('大家一起讨论日期、路线和预算。');
  checks.push('group and message survive reload');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('im-message-input')).toBeVisible();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Narrow layout overflows');
  await page.screenshot({ path: join(output, 'group-narrow.png') });
  checks.push('390px layout has no horizontal overflow');
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile(join(output, 'report.json'), JSON.stringify({ synthetic: true, checks, directoryCalls, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ synthetic: true, checks, output }));
} finally { await browser?.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); }
