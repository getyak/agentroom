import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { createPersonalServer } from '../apps/personal/server/index.mjs';
// Browser plugin not available. Use existing Playwright with isolated synthetic profiles.
// Flow: ordinary group -> share review -> invitation acceptance -> same conversation -> shared artifact/game.
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test'), evidence = process.env.AGENTROOM_EVIDENCE_DIR;
if (!evidence) throw new Error('Set AGENTROOM_EVIDENCE_DIR');
await mkdir(join(evidence, 'screenshots'), { recursive: true });
const inventory = { agents: [{ id: 'codex', name: 'Codex', installed: true, auth: { status: 'configured' }, execution: { supported: true }, profile: { agentId:'codex', defaults:{provider:'openai',model:'fixture-model',thinking:'low'},providers:['openai'],models:[{provider:'openai',id:'fixture-model',reasoning:true,thinkingLevels:['low']}],thinkingLevels:['low'],version:'fixture-v1' } }] };
const host = await createPersonalServer({ autoGroupNetwork: false, dataDir: join(evidence, `integrated-browser-${Date.now()}`), port: 0, staticDir: resolve('apps/personal/dist'), discoverLocalAgents: async () => inventory,
  guestSession: async () => ({ deps: {}, close() {} }), executeLocalAgent: async input => {
    const context = JSON.parse(input.prompt.split('<untrusted_thread_context>\n')[1].split('\n</untrusted_thread_context>')[0]);
    return { markdown: JSON.stringify({ action: 'reply', text: `${context.agentIdentity.name}：一起把这个周末安排好。` }) };
  } });
await host.listen(); host.playrooms.messenger.sync(inventory); host.store.put('setting', { id: 'workspace-onboarding', completed: true });
const base = host.store.require('contact', 'agent_codex'); host.store.put('contact', { ...base, added: true });
for (const [id, name] of [['planner', '路线搭子'], ['budget', '预算搭子']]) host.store.put('contact', { ...base, id, name, handle: id, discovered: false, instructions: 'PRIVATE_OWNER_ROLE', added: true });
const thread = host.playrooms.messenger.createChat({ kind: 'group', title: '把周末交给海风', memberIds: ['planner', 'budget'] });
thread.messages.push({ id: 'private_old', role: 'user', contactId: 'self', text: 'PRIVATE_OLD_CONTEXT', createdAt: new Date().toISOString() }); host.store.put('thread', thread);
const browser = await chromium.launch({ headless: true }), errors = [], owner = await browser.newPage({ viewport: { width: 1280, height: 900 } });
owner.on('pageerror', error => errors.push(error.message));
let status = 'failed';
const assertRosterLayout = async page => {
  const rows = await page.getByTestId('group-roster').locator('.group-member').evaluateAll(elements => elements.map(row => {
    const avatar = row.querySelector('.im-avatar').getBoundingClientRect(), details = row.querySelector('.group-member-details').getBoundingClientRect(), bounds = row.getBoundingClientRect();
    return { width: avatar.width, height: avatar.height, avatarRight: avatar.right, detailsLeft: details.left, avatarTop: avatar.top, avatarBottom: avatar.bottom, rowTop: bounds.top, rowBottom: bounds.bottom };
  }));
  assert.ok(rows.length >= 3);
  assert.ok(rows.every(row => row.width >= 20 && row.width <= 48 && Math.abs(row.width - row.height) <= 1 && row.avatarRight <= row.detailsLeft && row.avatarTop >= row.rowTop && row.avatarBottom <= row.rowBottom), 'Roster portraits must stay square, within their row and beside member details');
};
try {
  const origin = `http://127.0.0.1:${host.address().port}`;
  await owner.goto(`${origin}/?thread=${thread.id}`);
  await owner.getByTestId('group-sharing-open').click({ timeout: 5000 });
  await expect(owner.getByTestId('group-roster')).toContainText('路线搭子');
  await assertRosterLayout(owner);
  await owner.screenshot({ path: join(evidence, 'screenshots', 'integrated-owner-roster.png') });
  await owner.getByTestId('group-tab-invite').click();
  await owner.getByTestId('group-recipe-travel').click();
  await owner.getByTestId('group-brief').fill('11 月的周末去海边，不赶路，人均 800。');
  await owner.getByTestId('group-prepare').click();
  await expect(owner.getByTestId('group-publish')).toBeVisible();
  await owner.getByTestId('group-publish').click(); await expect(owner.getByTestId('group-copy-invite')).toBeVisible();
  const room = host.playrooms.current(thread.id); await host.playrooms.listen(); const invitation = host.playrooms.invitation(room.id);
  const pages = [];
  for (const [width, name] of [[1280, '小海'], [390, '小海']]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } }), page = await context.newPage(); pages.push(page); page.on('pageerror', e => errors.push(e.message));
    await page.goto(invitation.localUrl); await page.getByTestId('play-nickname').fill(name); await page.getByTestId('play-join').click();
    await expect(page.getByTestId('group-guest-chat')).toBeVisible(); await expect(page.getByTestId('im-timeline')).not.toContainText('PRIVATE_');
    await page.getByTestId('group-guest-people').click();
    await assertRosterLayout(page);
    await page.screenshot({ path: join(evidence, 'screenshots', `integrated-guest-roster-${width}.png`) });
    await page.getByTestId('group-guest-people').click();
  }
  const [a, b] = pages;
  const portraitImages=page=>page.getByTestId('group-guest-chat').getByTestId('im-group-member-avatar').evaluateAll(elements=>elements.map(e=>({id:e.dataset.memberId,src:e.querySelector('img')?.getAttribute('src'),text:e.textContent})));
  const images=await portraitImages(b), guests=images.filter(p=>p.id.startsWith('guest_'));
  assert.equal(guests.length,2);assert.ok(guests.every(p=>p.src.includes('people-anime-')&&!p.text));
  const ownerPortrait=await owner.getByTestId('im-profile').getByTestId('im-avatar-image').getAttribute('src');assert.equal(images.find(p=>p.id==='self').src,ownerPortrait);

  let release;
  await a.route(`**/g-api/${room.id}/actions`, async route => {
    if (route.request().postDataJSON().type !== 'message') return route.continue();
    const response = await route.fetch(); await new Promise(resolve => { release = async () => { await route.fulfill({ response }); resolve(); }; });
  });
  await a.getByTestId('group-message').fill('我们一起出发吧'); await a.getByTestId('group-send').click();
  await expect.poll(() => Boolean(release)).toBe(true); await a.getByTestId('group-message').fill('等待时继续写的下一句'); await release();
  await expect(a.getByTestId('group-message')).toHaveValue('等待时继续写的下一句'); await a.unroute(`**/g-api/${room.id}/actions`);
  await expect(b.getByTestId('im-timeline')).toContainText('路线搭子：一起把这个周末安排好。');
  await expect(b.getByTestId('im-timeline')).toContainText('预算搭子：一起把这个周末安排好。');
  await owner.getByTestId('group-tab-artifacts').click();
  await owner.getByTestId('group-artifact-note').click(); await owner.getByTestId('group-artifact-title').fill('海风小抄'); await owner.getByTestId('group-artifact-text').fill('慢慢走，一起做决定。'); await owner.getByTestId('group-artifact-create').click();
  const note = host.store.list('group_artifact').find(a => a.kind === 'note');
  await b.getByTestId('group-guest-artifacts').click(); await expect(b.getByTestId(`group-note-${note.id}`)).toBeVisible();
  await b.getByTestId(`group-note-${note.id}`).fill('慢慢走，一起做决定。记得带相机。'); await b.getByTestId(`group-note-save-${note.id}`).click();
  await expect(owner.getByTestId(`group-note-${note.id}`)).toHaveValue('慢慢走，一起做决定。记得带相机。');
  await owner.getByTestId('group-artifact-quiz').click(); await owner.getByTestId('group-artifact-title').fill('谁最懂我们'); await owner.getByTestId('group-artifact-create').click();
  const quiz = host.store.list('group_artifact').find(a => a.kind === 'quiz'); await b.getByTestId(`group-choice-${quiz.id}-choice_0`).click();
  await expect(owner.getByTestId(`group-choice-${quiz.id}-choice_0`)).toContainText('1');
  await expect(owner.getByTestId('group-roster')).toContainText('小海');
  await b.getByTestId(`group-note-${note.id}`).fill('断线时保留的草稿');
  await b.route('**/g-api/**', route => route.abort()); await expect(b.getByTestId('play-connection-state')).toBeVisible({ timeout: 7000 });
  await expect(b.getByTestId(`group-note-${note.id}`)).toHaveValue('断线时保留的草稿'); await b.unroute('**/g-api/**');
  await expect(b.getByTestId('play-connection-state')).toBeHidden({ timeout: 7000 }); await expect(b.getByTestId(`group-note-${note.id}`)).toHaveValue('断线时保留的草稿');
  await owner.screenshot({ path: join(evidence, 'screenshots', 'integrated-owner.png') }); await b.screenshot({ path: join(evidence, 'screenshots', 'integrated-mobile-artifacts.png') });
  await b.getByTestId('group-guest-chat-tab').click(); await b.screenshot({ path: join(evidence, 'screenshots', 'integrated-mobile-chat.png') });
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile overflow');
  const identity = await b.evaluate(() => fetch(location.pathname.replace('/g/', '/g-api/')).then(r => r.json()).then(r => r.me.id));
  await b.reload(); await expect(b.getByTestId('group-guest-chat')).toBeVisible();
  assert.deepEqual((await portraitImages(b)).filter(p=>p.id.startsWith('guest_')),guests);
  assert.equal(await b.evaluate(() => fetch(location.pathname.replace('/g/', '/g-api/')).then(r => r.json()).then(r => r.me.id)), identity);
  await a.getByTestId('group-message').fill('响应丢失后也只发送一次');
  await a.route(`**/g-api/${room.id}/actions`, async route => { if (route.request().postDataJSON().type !== 'message') return route.continue(); await route.fetch(); await route.abort(); });
  await a.getByTestId('group-send').click(); await expect(a.getByTestId('group-reconcile-send')).toBeVisible();
  await a.unroute(`**/g-api/${room.id}/actions`); await a.reload(); await expect(a.getByTestId('group-guest-chat')).toBeVisible();
  await a.getByTestId('group-reconcile-send').click(); await expect(a.getByTestId('group-message')).toHaveValue('');
  await a.route(`**/g-api/${room.id}/actions`, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'agent_unavailable', message: '这位伙伴暂不可用，请更正消息' } }) }));
  await a.getByTestId('group-message').fill('确定被拒绝的消息'); await a.getByTestId('group-send').click(); await expect(a.getByRole('alert')).toContainText('更正消息');
  await expect(a.getByTestId('group-reconcile-send')).toBeHidden(); await a.unroute(`**/g-api/${room.id}/actions`);
  await a.getByTestId('group-message').fill('更正后的新消息'); await a.getByTestId('group-send').click(); await expect(a.getByTestId('group-message')).toHaveValue('');
  assert.deepEqual(errors, []); assert.equal(host.store.list('play_job').length, 0); assert.equal(host.store.require('thread', thread.id).runs.length, 6);
  status = 'passed';
} finally { await writeFile(join(evidence, 'integrated-browser-result.json'), JSON.stringify({ status, errors }, null, 2)); await browser.close(); await host.close(); }
console.log(`Integrated groups browser acceptance: ${status}`);
