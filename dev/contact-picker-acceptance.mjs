// Synthetic local workspace only: no real accounts, models or user data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPersonalServer } from '../apps/personal/server/index.mjs';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const output = resolve(process.env.AGENTROOM_PICKER_EVIDENCE_DIR || 'output/playwright/contact-picker');
await mkdir(output, { recursive: true });
const inventory = { agents: ['codex', 'claude'].map(id => ({ id, name: id === 'codex' ? 'Codex' : 'Claude Code', installed: true, auth: { status: 'configured' }, execution: { supported: true } })) };
const host = await createPersonalServer({ dataDir: join(output, `data-${Date.now()}`), port: 0, staticDir: resolve('apps/personal/dist'), autoGroupNetwork: false, discoverLocalAgents: async () => inventory });
let browser, page;
const checks = [], errors = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
let status = 'failed';
try {
  await host.listen();
  const origin = `http://127.0.0.1:${host.address().port}`;
  await fetch(`${origin}/api/contacts`);
  host.store.put('setting', { id: 'workspace-onboarding', completed: true });
  const base = host.store.require('contact', 'agent_codex');
  const contact = (id, name, fields = {}) => host.store.put('contact', { ...base, id, name, handle: id.replaceAll('_', '-'), added: true, discovered: false, description: '', instructions: '', ...fields });
  contact('design', '产品品味官');
  contact('review', '产品品味官', { binding: { type: 'local', localAgentId: 'claude' }, color: 'teal' });
  contact('offline', '暂别的伙伴', { binding: { type: 'connection', connectionId: 'removed' } });
  contact('human', '小林', { kind: 'human', binding: null });
  for (let index = 0; index < 35; index++) contact(`partner_${index}`, `研究伙伴 ${String(index + 1).padStart(2, '0')}`, { color: ['blue', 'teal', 'orange', 'violet', 'rose'][index % 5] });
  const thread = host.playrooms.messenger.createChat({ kind: 'group', title: '一起把好想法做出来', memberIds: ['design', 'review', 'human'], responsePolicies: { design: 'mention', review: 'manual' }, allowSilence: true });
  const original = host.store.require('thread', thread.id);
  // Persist explicit policies as fixtures; this also tests preserving untouched policies.
  host.store.put('thread', { ...original, responsePolicies: { design: 'mention', review: 'manual' }, allowSilence: true });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/?thread=${thread.id}`);
  const open = async () => { await page.getByTestId('im-chat-info').click(); await expect(page.getByTestId('im-group-editor')).toBeVisible(); };
  const capture = name => page.screenshot({ path: join(output, `${name}.png`) });
  const bounds = async () => {
    const layout = await page.getByTestId('im-group-editor').evaluate(form => {
      const dialog = form.closest('dialog'), footer = form.querySelector('footer'), search = form.querySelector('[data-testid="im-group-search"]');
      const b = dialog.getBoundingClientRect(), f = footer.getBoundingClientRect(), s = search.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, footerBottom: f.bottom, searchTop: s.top, scrollWidth: dialog.scrollWidth, width: dialog.clientWidth, innerScroll: dialog.querySelector('.modal-inner').scrollTop };
    });
    const viewport = page.viewportSize();
    assert.ok(layout.left >= 0 && layout.right <= viewport.width + 1 && layout.top >= 0 && layout.bottom <= viewport.height + 1, JSON.stringify(layout));
    assert.ok(layout.footerBottom <= viewport.height && layout.searchTop >= 0 && layout.scrollWidth <= layout.width + 1 && layout.innerScroll === 0, JSON.stringify(layout));
    await expect(page.getByTestId('im-group-save')).toBeInViewport();
    await expect(page.getByTestId('im-group-search')).toBeInViewport();
    const tiles = await page.getByTestId('im-group-avatar-preview').getByTestId('im-group-member-avatar').evaluateAll(elements => elements.map(element => {
      const tile = element.getBoundingClientRect(), outer = element.closest('.im-group-avatar-preview').getBoundingClientRect();
      return { width: tile.width, height: tile.height, left: tile.left - outer.left, right: tile.right - outer.right, top: tile.top - outer.top, bottom: tile.bottom - outer.bottom, outerWidth: outer.width };
    }));
    assert.ok(tiles.every(tile => tile.width < tile.outerWidth && Math.abs(tile.width - tile.height) <= 1 && tile.left >= -1 && tile.right <= 1 && tile.top >= -1 && tile.bottom <= 1), JSON.stringify(tiles));
  };
  await open();
  await expect(page.getByTestId('im-group-search')).toBeFocused();
  await expect(page.getByTestId('im-group-selection-count')).toHaveText('3');
  await expect(page.getByTestId('im-picker-contact-design')).toContainText('Codex · @design');
  await expect(page.getByTestId('im-picker-contact-review')).toContainText('Claude Code · @review');
  await expect(page.getByTestId('im-member-offline')).toBeHidden();
  await bounds(); await capture('01-desktop');
  check('starts at a focused search with visible selected members, sources and fixed footer');

  const order = await page.getByTestId('im-group-results').getByTestId(/^im-picker-contact-/).evaluateAll(elements => elements.map(element => element.dataset.testid));
  await page.getByTestId('im-member-partner_0').check();
  assert.deepEqual(await page.getByTestId('im-group-results').getByTestId(/^im-picker-contact-/).evaluateAll(elements => elements.map(element => element.dataset.testid)), order);
  await page.getByTestId('im-group-filter-human').click();
  await expect(page.getByTestId('im-member-design')).toHaveCount(0);
  await expect(page.getByTestId('im-selected-design')).toBeVisible();
  await page.getByTestId('im-group-search').fill('找不到的名字');
  await expect(page.getByTestId('im-group-empty')).toBeVisible();
  await expect(page.getByTestId('im-group-selection-count')).toHaveText('4');
  await page.getByTestId('im-group-reset-filters').click();
  await page.getByTestId('im-group-search').fill('  @offline  ');
  // Search accepts the familiar @username form as well as the raw handle.
  await expect(page.getByTestId('im-member-offline')).toBeVisible();
  await expect(page.getByTestId('im-picker-contact-offline')).toContainText('连接已移除');
  await page.getByTestId('im-group-unavailable-toggle').click();
  await expect(page.getByTestId('im-member-offline')).toBeHidden();
  await page.getByTestId('im-group-search').fill('暂别');
  await expect(page.getByTestId('im-member-offline')).toBeVisible();
  await page.getByTestId('im-member-offline').check();
  await page.getByTestId('im-group-search-clear').click();
  await page.getByTestId('im-member-remove-offline').click();
  await expect(page.getByTestId('im-group-selection-count')).toHaveText('4');
  await page.getByTestId('im-group-search').fill('Claude Code');
  await expect(page.getByTestId('im-member-review')).toBeVisible();
  await expect(page.getByTestId('im-member-design')).toHaveCount(0);
  await page.getByTestId('im-group-search').press('Enter');
  await expect(page.getByTestId('im-group-editor')).toBeVisible();
  await page.getByTestId('im-group-search-clear').click();
  await page.getByTestId('im-member-design').focus(); await page.keyboard.press('Space');
  await expect(page.getByTestId('im-selected-design')).toHaveCount(0);
  await page.keyboard.press('Space'); await expect(page.getByTestId('im-selected-design')).toBeVisible();
  check('search, categories, empty states and keyboard toggles retain selection without reordering');

  for (const [width, height, mode] of [[1200,800,'dark'], [560,800,'light'], [390,680,'light'], [820,480,'light']]) {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
    await bounds(); await capture(`02-layout-${width}-${height}-${mode}`);
    await page.getByTestId('im-group-settings-toggle').click();
    await expect(page.getByTestId('im-group-silence')).toBeVisible();
    await expect(page.getByTestId('im-policy-design')).toHaveAttribute('aria-label', '产品品味官 @design的响应策略');
    await expect(page.getByTestId('im-policy-review')).toHaveAttribute('aria-label', '产品品味官 @review的响应策略');
    await bounds(); await capture(`03-settings-${width}-${height}-${mode}`);
    await page.getByTestId('im-group-settings-toggle').click();
  }
  check('long directory, dark mode, reduced motion and narrow/short layouts keep controls reachable');

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByTestId('im-group-settings-toggle').click();
  await page.getByTestId('im-policy-design').selectOption('always');
  await page.route(`**/api/chats/${thread.id}`, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { message: '合成保存失败，请重试' } }) }));
  await page.getByTestId('im-group-save').click();
  await expect(page.getByTestId('im-group-error')).toBeVisible();
  await expect(page.getByTestId('im-group-name')).toHaveValue(thread.title);
  await expect(page.getByTestId('im-group-selection-count')).toHaveText('4');
  await page.unroute(`**/api/chats/${thread.id}`);
  await page.getByTestId('im-group-save').click();
  await expect(page.getByTestId('im-group-editor')).toHaveCount(0);
  const saved = host.store.require('thread', thread.id);
  assert.equal(saved.responsePolicies.design, 'always'); assert.equal(saved.responsePolicies.review, 'manual'); assert.equal(saved.allowSilence, true);
  assert.deepEqual(new Set(saved.memberIds), new Set(['self', 'design', 'review', 'human', 'partner_0']));
  check('failed save retains draft; retry persists members and preserves untouched policies');

  await open();
  await page.getByTestId('im-member-remove-design').click();
  await page.getByTestId('im-group-cancel').click();
  await open(); await expect(page.getByTestId('im-selected-design')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('im-new').click(); await page.getByTestId('im-new-group').click();
  await expect(page.getByTestId('im-group-save')).toBeDisabled();
  await page.getByTestId('im-member-design').check();
  await expect(page.getByTestId('im-group-save')).toHaveText('开始私聊');
  await page.getByTestId('im-group-save').click();
  await expect(page.getByTestId('im-group-editor')).toHaveCount(0);
  const direct = host.store.list('thread').find(item => item.kind === 'direct' && item.memberIds.includes('design'));
  assert.ok(direct);
  await page.getByTestId('im-promote-group').click();
  await page.getByTestId('im-member-review').check();
  await expect(page.getByTestId('im-group-save')).toBeDisabled();
  await page.getByTestId('im-group-name').fill('新的讨论室');
  await page.getByTestId('im-group-save').click();
  await expect(page.getByTestId('im-group-editor')).toHaveCount(0);
  assert.ok(host.store.list('thread').some(item => item.kind === 'group' && item.title === '新的讨论室' && item.memberIds.length === 3));
  check('cancel discards changes; one contact starts a DM and two create a named group');

  const group = host.store.list('thread').find(item => item.title === '新的讨论室');
  host.store.put('thread', { ...group, memberIds: [...group.memberIds, 'historical_missing'] });
  await page.reload(); await open();
  await expect(page.getByTestId('im-selected-historical_missing')).toContainText('未找到的联系人');
  await page.getByTestId('im-group-filter-human').click();
  await expect(page.getByTestId('im-selected-historical_missing')).toBeVisible();
  await page.getByTestId('im-member-remove-historical_missing').click();
  await expect(page.getByTestId('im-selected-historical_missing')).toHaveCount(0);
  check('missing historical contacts stay represented until explicitly removed');
  assert.deepEqual(errors, []); status = 'passed';
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ status, synthetic: true, checks, errors }, null, 2));
  await browser?.close(); await host.close();
}
