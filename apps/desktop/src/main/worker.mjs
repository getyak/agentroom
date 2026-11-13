// Copied beside the backend ESM modules. No browser sessions or
// renderer-provided paths are read here; only the owning main process configures it.
import { createPersonalServer } from './index.mjs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

let application, ownerId, starting = false, closing = false;
const send = (message) => process.parentPort?.postMessage({ ...message, ownerId });

async function close() {
  if (closing) return;
  closing = true;
  if (starting && !application) return;
  await application?.close(); send({ type: 'stopped' }); process.exit(0);
}

process.parentPort.on('message', async ({ data }) => {
  if (data?.type === 'artifact-preview-result' && application && !closing) {
    try { application.creation.runtime.recordPreviewCheck(data.workId, data.revisionId, data.checks); } catch { /* An old check cannot complete a changed work. */ }
    return;
  }
  if (data?.type === 'register-native-source' && application && data.ownerId === ownerId && !closing) {
    try { application.registerNativeSource(data.source); send({ type: 'native-source-ready', requestId: data.requestId }); }
    catch { send({ type: 'native-source-ready', requestId: data.requestId, error: true }); }
    return;
  }
  if (data?.type === 'sync-native-services' && application && data.ownerId === ownerId && !closing) {
    try { const instances = application.syncNativeServices(data.snapshot); send({ type: 'native-services-ready', requestId: data.requestId, instances }); }
    catch { send({ type: 'native-services-ready', requestId: data.requestId, error: true }); }
    return;
  }
  if (data?.type === 'cancel-switch') { application?.cancelWorkspaceSwitch(); return; }
  if (data?.type === 'prepare-switch' && application && !closing) {
    try { send({ type: 'switch-ready', requestId: data.requestId, ...await application.prepareWorkspaceSwitch() }); }
    catch { send({ type: 'switch-ready', requestId: data.requestId, error: true }); }
    return;
  }
  if (data?.type === 'stop') { await close(); return; }
  if (data?.type !== 'start' || starting || application || closing) return;
  starting = true; ownerId = data.ownerId;
  try {
    const probe = new DatabaseSync(':memory:');
    const sqlite = probe.prepare('SELECT sqlite_version() AS version').get().version; probe.close();
    application = await createPersonalServer({ dataDir: data.dataDir, port: 0, host: '127.0.0.1', staticDir: data.staticDir,
      ...(data.staticDir ? { staticAssetsDir: resolve(data.staticDir, '..', 'assets') } : {}),
      buildRef: data.buildRef, codexCommand: data.codexCommand,
      onChange: (event) => { if (!closing) send({ type: 'changed', event }); } });
    starting = false;
    if (closing) { await application.close(); process.exit(0); return; }
    const address = await application.listen();
    send({ type: 'ready', workspace: application.store.dataDir, port: address.port, runtime: { electron: process.versions.electron, node: process.versions.node, sqlite } });
    application.creation.runtime.resumePreviews();
  } catch (error) {
    starting = false;
    await application?.close();
    send({ type: 'startup_error', code: error?.code || 'personal_start_failed',
      message: error?.code || /already open/.test(error?.message || '') ? String(error.message).slice(0, 600) : '本机后台无法启动，请检查运行环境与工作区占用后重试' });
    process.exit(1);
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void close(); });
process.parentPort.once('close', () => { void close(); });
