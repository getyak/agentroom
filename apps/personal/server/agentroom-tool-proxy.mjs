// MCP stdio: stdout contains JSON-RPC only. Session capabilities never reach models.
import { StringDecoder } from 'node:string_decoder';

const endpoint = process.env.AGENTROOM_TOOL_ENDPOINT, token = process.env.AGENTROOM_TOOL_TOKEN;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]+$/.test(endpoint) || !token) process.exit(2);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
let initialized = false, framed = '';
const decoder = new StringDecoder('utf8');
const reply = (id, result, error) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) })}\n`);
async function dispatch(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'notifications/initialized') { initialized = true; return; }
  if (message.id === undefined) return;
  try {
    if (message.method === 'initialize') return reply(message.id, { protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-11-25', serverInfo: { name: 'agentroom-tools', version: '1.1.0' }, capabilities: { tools: {} }, instructions: 'Use only supplied scoped tools. mcp_search discovers tools; mcp_request submits an owner approval, never executes it. Its eventual result appears in the original chat. Artifact proposals also need approval. Do not claim work that no tool completed.' });
    if (!initialized) return reply(message.id, undefined, { code: -32002, message: 'Not initialized' });
    if (message.method === 'ping') return reply(message.id, {});
    if (message.method === 'tools/list') {
      const response = await fetch(endpoint, { headers }); const body = await response.json();
      if (!response.ok) throw new Error('Tool session unavailable');
      return reply(message.id, body);
    }
    if (message.method !== 'tools/call') return reply(message.id, undefined, { code: -32601, message: 'Method not found' });
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ name: message.params?.name, arguments: message.params?.arguments || {}, callId: `mcp-${message.id}` }) });
    const body = await response.json();
    const result = response.ok ? body.result : body;
    reply(message.id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : { value: result }, isError: !response.ok });
  } catch { reply(message.id, undefined, { code: -32000, message: 'Tool transport unavailable; do not retry mutations without reconciliation' }); }
}
process.stdin.on('data', chunk => {
  framed += decoder.write(chunk);
  if (Buffer.byteLength(framed) > 2_000_000) { process.exitCode = 2; process.stdin.destroy(); return; }
  let at;
  while ((at = framed.indexOf('\n')) >= 0) {
    const line = framed.slice(0, at); framed = framed.slice(at + 1);
    try { void dispatch(JSON.parse(line)); } catch { reply(null, undefined, { code: -32700, message: 'Parse error' }); }
  }
});
