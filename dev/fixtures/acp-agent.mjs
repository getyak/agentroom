// Synthetic ACP v1 process; it never loads accounts or invokes a model.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const mode = process.argv[2] || 'normal';
let descendantReady;
if (mode === 'descendant') {
  descendantReady = new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.send(process.pid); setInterval(()=>{},1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', pid => resolve(pid));
  });
  process.on('SIGTERM', () => process.exit(0));
}
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let permission;
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') return send({ id: request.id, result: { protocolVersion: mode === 'version' ? 2 : 1, agentInfo: { name: 'synthetic', version: '1' }, agentCapabilities: {}, authMethods: [] } });
  if (request.method === 'session/new') {
    if (mode === 'auth') return send({ id: request.id, error: { code: -32000, message: 'Authentication required: SECRET_MUST_NOT_LEAK' } });
    return send({ id: request.id, result: { sessionId: 'isolated-' + process.pid } });
  }
  if (request.method === 'session/prompt') {
    if (mode === 'descendant') {
      const pid = await descendantReady;
      send({ method: 'session/update', params: { sessionId: 'isolated-' + process.pid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(pid) } } } });
      return send({ id: request.id, result: { stopReason: 'end_turn' } });
    }
    if (mode === 'invalid') return process.stdout.write('NOT JSON\n');
    if (mode === 'hang') return;
    if (mode === 'permissions' || mode === 'chat-permissions') { permission = request; return send({ id: 999, method: 'session/request_permission', params: { sessionId: 'isolated-' + process.pid, toolCall: { toolCallId: 'write' }, options: [{ optionId: 'yes', kind: 'allow_once', name: 'write' }, { optionId: 'no', kind: 'reject_once', name: 'reject' }] } }); }
    const value = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'isolated-' + process.pid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: mode === 'chat' ? '{"action":"reply","text":"ACP 合成回复"}' : '你好，' } } } }) + '\n';
    const bytes = Buffer.from(value), split = bytes.indexOf(Buffer.from('你')) + 1;
    process.stdout.write(bytes.subarray(0, split)); process.stdout.write(bytes.subarray(split));
    send({ method: 'session/update', params: { sessionId: 'isolated-' + process.pid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_THINKING' } } } });
    send({ method: 'session/update', params: { sessionId: 'isolated-' + process.pid, update: { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: mode === 'chat' ? '' : '世界' } } } });
    send({ id: request.id, result: { stopReason: 'end_turn' } });
  }
  if (request.id === 999 && permission) {
    const text = request.result?.outcome?.optionId === 'no' ? '权限已拒绝' : 'BAD_PERMISSION';
    send({ method: 'session/update', params: { sessionId: 'isolated-' + process.pid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: mode === 'chat-permissions' ? JSON.stringify({ action: 'reply', text }) : text } } } });
    send({ id: permission.id, result: { stopReason: 'end_turn' } });
  }
  if (request.method === 'session/cancel') process.exit(0);
});
