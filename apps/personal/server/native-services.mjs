// Private owner-to-worker projection. Never exposed as an HTTP/preload mutation.
import { connectionIdentity, now } from './store.mjs';
const services = ['grokbot', 'muse', 'dots', 'cue'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const png = value => typeof value === 'string' && value.length <= 683_000 && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value);
export function nativeSource(store, connection) {
 const source = store.get('native_service_source', connection.id);
 return source && same(source.identity, connectionIdentity(connection)) ? source : null;
}
export function syncNativeServices(store, snapshot, notify) {
 if (!snapshot || !Number.isInteger(snapshot.port) || snapshot.port < 1 || snapshot.port > 65535 || !Array.isArray(snapshot.instances) || !Array.isArray(snapshot.tasks)) throw new Error('Invalid owned service snapshot');
 const sources = new Map(), catalog = [], threads = store.list('thread'); let changed = false;
 for (const connection of store.list('connection')) {
  if (connection.type !== 'a2a') continue;
  const url = new URL(connection.url), match = /^\/a2a\/([A-Za-z0-9_-]{1,160})$/.exec(url.pathname);
  if (url.origin !== `http://127.0.0.1:${snapshot.port}` || !match || url.search || url.hash || url.username || url.password) continue;
  const instanceId = match[1], instance = snapshot.instances.find(item => item.id === instanceId);
  const previous = nativeSource(store, connection);
  const approval = store.get('native_approval_source', connection.id);
  const matchesBinding = run => {
   const binding = store.get('message_identity', run.id);
   if (!binding) return false;
   const { id: _id, ...identity } = binding;
   return same(identity, connectionIdentity(connection));
  };
  const ownedApproval = approval?.instanceId === instanceId && same(approval.identity, connectionIdentity(connection));
  const ownedReceipt = threads.some(thread => thread.runs?.some(run => run.connectionId === connection.id && matchesBinding(run)
   && snapshot.tasks.some(task => task.instanceId === instanceId && task.messageId === (run.dispatchMessageId || run.id) && task.id === run.externalTaskId)));
  if (!instance && !previous && !ownedApproval && !ownedReceipt) continue;
  const service = services.includes(instance?.service) ? instance.service : previous?.service || (ownedApproval ? 'grokbot' : undefined);
  const source = { id: connection.id, instanceId, identity: connectionIdentity(connection),
   ...(service ? { service } : {}), status: instance?.status || 'missing',
   ...(png(instance?.avatarDataUrl) ? { avatarDataUrl: instance.avatarDataUrl } : previous?.avatarDataUrl ? { avatarDataUrl: previous.avatarDataUrl } : {}) };
  if (!same(source, previous)) { store.put('native_service_source', source); changed = true; }
  sources.set(connection.id, source);
  catalog.push({ id: instanceId, connectionId: connection.id, name: connection.name, status: source.status === 'missing' ? 'needs_login' : source.status,
   ...(service ? { service } : {}), hasCredentials: Boolean(instance), canOpen: Boolean(instance?.canOpen), ...(source.avatarDataUrl ? { avatarDataUrl: source.avatarDataUrl } : {}) });
 }
 for (const thread of threads) {
  let repaired = false;
  for (const run of thread.runs || []) {
   if (run.mode !== 'connection' || run.status !== 'unknown' || run.externalTaskId || run.phase !== 'dispatch') continue;
   const source = sources.get(run.connectionId);
   const binding = store.get('message_identity', run.id);
   if (!source || !binding) continue;
   const { id: _runId, ...acceptedIdentity } = binding;
   if (!same(acceptedIdentity, source.identity)) continue;
   const receipt = snapshot.tasks.find(task => task.instanceId === source.instanceId && task.messageId === (run.dispatchMessageId || run.id));
   if (receipt) {
    run.externalTaskId = receipt.id; run.remoteReceipt = { taskId: receipt.id, receivedAt: now(), source: 'owned_service_ledger' };
   } else {
    // Only previous process generations are quiescent. A timed-out request
    // in this process may still reach its durable-acceptance boundary.
    if (!run.finishedAt || !(Date.parse(run.finishedAt) < Date.parse(snapshot.startedAt))) continue;
    // This adapter fsyncs its task before dispatch. An intact, owner-bound
    // ledger with no matching stable message ID proves it never dispatched.
    run.status = 'failed'; run.deliveryState = 'not_sent'; run.actionState = 'not_started'; run.requiresReconciliation = false;
    run.error = '这条消息没有发送到原服务。请恢复连接后重试。'; run.finishedAt = now();
    store.event(thread, 'failed', run.error, { runId: run.id });
   }
   repaired = true;
  }
  if (repaired) { store.refreshThread(thread); store.put('thread', thread); notify({ threadId: thread.id }); }
 }
 if (changed) notify({});
 return catalog;
}
