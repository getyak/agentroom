import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createPersonalServer } from './index.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-api-')), events = new EventEmitter(); let n = 0;
  const profile = { agentId: 'codex', defaults: { provider: 'synthetic', model: 'test', thinking: 'off' }, providers: ['synthetic'], models: [], thinkingLevels: ['off'], version: 'fixture' };
  const app = await createPersonalServer({ dataDir: directory, port: 0,
    discoverLocalAgents: async () => ({ agents: [{ id: 'codex', name: 'Codex', installed: true, auth: { status: 'configured' }, execution: { supported: true }, profile }] }),
    executeLocalAgent: async input => {
      const call = async (name, args = {}) => {
        const response = await fetch(input.toolSession.endpoint, { method: 'POST', headers: { authorization: `Bearer ${input.toolSession.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args, callId: `api-tool-${++n}` }) });
        const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value.result;
      };
      if (input.toolSession.toolNames.includes('creation_propose')) {
        await call('creation_propose', { title: 'API website', kind: 'website', goal: 'Make one real immutable page', task: 'Create the page', writePaths: ['index.html'] });
        return { markdown: JSON.stringify({ action: 'reply', text: '建议做一个清晰的页面。' }), identity: { id: 'codex' } };
      }
      await call('artifact_read'); await call('artifact_write', { path: 'index.html', text: '<!doctype html><h1>Verified page</h1>', expectedHash: null });
      await call('artifact_submit', { summary: 'Page' }); await call('task_complete', { summary: 'Done' });
      return { markdown: 'Done', identity: { id: 'codex' } };
    }, onChange: () => events.emit('change') });
  await app.listen();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const api = async (path, body) => { const res = await fetch(`http://127.0.0.1:${app.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const wait = predicate => new Promise((resolve, reject) => { const check = () => { if (!predicate()) return; clearTimeout(timer); events.off('change', check); resolve(); }; const timer = setTimeout(() => { events.off('change', check); reject(new Error('State did not arrive')); }, 6000); events.on('change', check); check(); });
  app.store.put('contact',{id:'group_peer',kind:'human',name:'讨论伙伴',handle:'group-peer',version:1});
  await api('/contacts'); const chat = (await api('/chats', { kind: 'group', title: 'API group', memberIds: ['agent_codex','group_peer'], clientId: 'api-create-chat' })).body;
  await api(`/threads/${chat.id}/messages`, { text: '做一个静态网页', clientId: 'api-create-message' });
  await wait(() => app.store.require('thread', chat.id).runs.every(run => run.status === 'completed'));
  return { app, api, wait, chat };
}

test('owner routes approve one plan, expose checked immutable preview and preserve legacy artifacts', async t => {
  const f = await fixture(t);
  const state = await f.api(`/threads/${f.chat.id}/creation`); assert.equal(state.status, 200);
  const proposal = state.body.proposals[0]; assert.equal(proposal.state, 'ready');
  assert.ok((await f.api('/workspace/status')).body.blockingRuns > 0, 'pending plan blocks profile switching');
  const approved = await f.api(`/creation-proposals/${proposal.id}/decision`, { choice: 'approve', version: proposal.version, clientId: 'api-owner-approval' }); assert.equal(approved.status, 200);
  await f.wait(() => f.app.store.list('collaboration')[0]?.status === 'waiting_preview');
  const waiting = f.app.store.list('collaboration')[0]; f.app.creation.runtime.recordPreviewCheck(waiting.id, waiting.finalRevisionId, { passed: true, errors: [], viewports: [{ width: 390 }] });
  const library = await f.api('/library/artifacts'); assert.equal(library.body.artifacts.length, 1);
  const artifact = library.body.artifacts[0], detail = await f.api(`/library/artifacts/${artifact.id}`); assert.equal(detail.body.revisions.length, 2);
  const preview = await f.api(`/library/artifacts/${artifact.id}/preview`, { revisionId: artifact.headRevisionId }); assert.equal(preview.status, 200);
  const metadata = await f.api(`/library/previews/${preview.body.id}`), entry = metadata.body.files.find(file => file.path === 'index.html');
  const bytes = await f.api(`/library/previews/${preview.body.id}/files/${entry.id}`); assert.match(bytes.body.text, /Verified page/); assert.equal(bytes.body.mime, 'text/html');
  assert.equal((await f.api(`/library/previews/${preview.body.id}/files/not-a-real-file`)).status, 404);
  assert.equal((await f.api(`/library/artifacts/${artifact.id}/files`, { revisionId: artifact.headRevisionId, path: '../../secrets' })).status, 400);
  const old = f.app.store.require('thread', f.chat.id).artifacts[0]; assert.equal((await f.api(`/artifacts/${old.id}`)).status, 200);
  assert.equal((await f.api('/workspace/status')).body.blockingRuns, 0);
});

test('generic thread retry cannot bypass the collaboration state machine', async t => {
  const f = await fixture(t), proposal = f.app.store.list('creation_proposal')[0];
  await f.api(`/creation-proposals/${proposal.id}/decision`, { choice: 'approve', version: proposal.version, clientId: 'api-approve-control' });
  await f.wait(() => f.app.store.list('collaboration')[0]?.status === 'waiting_preview');
  const waiting = f.app.store.list('collaboration')[0]; f.app.creation.runtime.recordPreviewCheck(waiting.id, waiting.finalRevisionId, { passed: true, errors: [], viewports: [{ width: 390 }] });
  const run = f.app.store.require('thread', f.chat.id).runs.find(item => item.collaboration);
  assert.equal((await f.api(`/threads/${f.chat.id}/retry`, { runId: run.id, clientId: 'unsafe-generic-retry' })).status, 409);
});

test('owner file edits and acceptance are durable through their real fixed API routes', async t => {
  const f = await fixture(t), proposal = f.app.store.list('creation_proposal')[0];
  await f.api(`/creation-proposals/${proposal.id}/decision`, { choice: 'approve', version: proposal.version, clientId: 'approve-human-edit-api' });
  await f.wait(() => f.app.store.list('collaboration')[0]?.status === 'waiting_preview');
  const work = f.app.store.list('collaboration')[0]; f.app.creation.runtime.recordPreviewCheck(work.id, work.finalRevisionId, { passed: true, errors: [], viewports: [{ width: 390 }] });
  const artifact = f.app.store.require('workspace_artifact', work.artifactId), source = (await f.api(`/library/artifacts/${artifact.id}/files`, { revisionId: artifact.headRevisionId, path: 'index.html' })).body.files[0];
  const body = { action: 'edit', expectedVersion: artifact.version, path: 'index.html', expectedHash: source.sha256, text: '<!doctype html><h1>Human contribution</h1>', clientId: 'human-file-edit-via-api' };
  const edited = await f.api(`/library/artifacts/${artifact.id}/change`, body); assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const replay = await f.api(`/library/artifacts/${artifact.id}/change`, body); assert.equal(replay.body.headRevisionId, edited.body.headRevisionId);
  const accepted = await f.api(`/library/artifacts/${artifact.id}/change`, { action: 'accept', expectedVersion: edited.body.version, revisionId: edited.body.headRevisionId, clientId: 'accept-human-file-edit' });
  assert.equal(accepted.body.acceptedRevisionId, edited.body.headRevisionId);
});

test('opening an artifact detects fresh Finder edits before another model submission', async t => {
  const f = await fixture(t), proposal = f.app.store.list('creation_proposal')[0];
  await f.api(`/creation-proposals/${proposal.id}/decision`, { choice: 'approve', version: proposal.version, clientId: 'finder-edit-detection' });
  await f.wait(() => f.app.store.list('collaboration')[0]?.status === 'waiting_preview');
  const work = f.app.store.list('collaboration')[0]; f.app.creation.runtime.recordPreviewCheck(work.id, work.finalRevisionId, { passed: true, errors: [], viewports: [] });
  const { writeFileSync } = await import('node:fs'); writeFileSync(join(f.app.store.dataDir, 'artifacts', work.artifactId, 'current', 'human.md'), 'A fresh human note');
  const detail = await f.api(`/library/artifacts/${work.artifactId}`); assert.equal(detail.body.artifact.materializationState, 'blocked_by_local_changes');
});

test('a lost owner edit acknowledgement is recovered from its committed contribution', async t => {
  const f = await fixture(t), proposal = f.app.store.list('creation_proposal')[0];
  await f.api(`/creation-proposals/${proposal.id}/decision`, { choice: 'approve', version: proposal.version, clientId: 'recover-owner-ack-seed' });
  await f.wait(() => f.app.store.list('collaboration')[0]?.status === 'waiting_preview');
  const work = f.app.store.list('collaboration')[0]; f.app.creation.runtime.recordPreviewCheck(work.id, work.finalRevisionId, { passed: true, errors: [], viewports: [] });
  const artifact = f.app.store.require('workspace_artifact', work.artifactId), file = (await f.api(`/library/artifacts/${artifact.id}/files`, { revisionId: artifact.headRevisionId, path: 'index.html' })).body.files[0];
  const body = { action: 'edit', path: 'index.html', text: '<h1>Recovered owner edit</h1>', expectedHash: file.sha256, expectedVersion: artifact.version, clientId: 'lost-owner-acknowledgement' };
  const saved = await f.api(`/library/artifacts/${artifact.id}/change`, body); assert.equal(saved.status, 200);
  const operation = f.app.store.list('artifact_owner_operation')[0]; delete operation.result; operation.state = 'pending'; f.app.store.put('artifact_owner_operation', operation);
  const { ArtifactAPI } = await import('./artifact-api.mjs'); const reopened = new ArtifactAPI(f.app.creation, () => {}); reopened.close();
  const replay = await f.api(`/library/artifacts/${artifact.id}/change`, body); assert.equal(replay.status, 200); assert.equal(replay.body.headRevisionId, saved.body.headRevisionId);
});

test('owner-only details retain private work records while group cards expose only fixed status', async t => {
  const f = await fixture(t), proposal = f.app.store.list('creation_proposal')[0];
  await f.api(`/creation-proposals/${proposal.id}/decision`, { choice: 'approve', version: proposal.version, clientId: 'owner-private-details' });
  await f.wait(() => f.app.store.list('collaboration')[0]?.status === 'waiting_preview');
  const work = f.app.store.list('collaboration')[0]; work.messages.push({ text: 'PRIVATE_DETAIL_TEXT' }); work.steps[0].summary = 'PRIVATE_STEP_SUMMARY'; f.app.store.put('collaboration', work);
  const publicState = await f.api(`/threads/${f.chat.id}/creation`), owner = await f.api(`/collaborations/${work.id}`);
  assert.ok(!JSON.stringify(publicState.body).includes('PRIVATE_')); assert.match(JSON.stringify(owner.body), /PRIVATE_DETAIL_TEXT/); assert.equal(owner.body.runs.length, 1);
  const operation = { id: 'owner_unknown_receipt', artifactId: work.artifactId, action: 'edit', state: 'unknown' }; f.app.store.put('artifact_owner_operation', operation);
  const artifact = f.app.store.require('workspace_artifact', work.artifactId);
  const missingReview = await f.api(`/library/artifacts/${artifact.id}/change`, { action: 'reconcile-owner', operationId: operation.id, expectedVersion: artifact.version, clientId: 'missing-owner-review' }); assert.equal(missingReview.status, 409);
  const resolved = await f.api(`/library/artifacts/${artifact.id}/change`, { action: 'reconcile-owner', operationId: operation.id, expectedVersion: artifact.version, confirmedReviewed: true, clientId: 'reviewed-owner-abandon' }); assert.equal(resolved.status, 200); assert.equal(f.app.store.require('artifact_owner_operation', operation.id).state, 'abandoned');
});
