import { publicAgentInfo } from './agent-info.mjs';
import { APIError } from './store.mjs';

// Fixed first-party documented endpoints; adding one performs discovery only.
export const TOOL_PRESETS = Object.freeze([
  { id: 'deepwiki', name: 'DeepWiki', description: '查阅公开代码仓库的文档', type: 'mcp', url: 'https://mcp.deepwiki.com/mcp', account: '公开服务，无需登录', website: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp' },
  { id: 'exa', name: 'Exa 搜索', description: '搜索公开网页与技术资料', type: 'mcp', url: 'https://mcp.exa.ai/mcp', account: '公开入口，无需填写密钥', website: 'https://exa.ai/mcp' },
]);

export function integrationURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new APIError(400, 'invalid_connection_url', '请粘贴服务提供的连接地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new APIError(400, 'invalid_connection_url', '使用不含密码或查询参数的 HTTP(S) 连接地址；访问令牌请单独填写');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new APIError(400, 'invalid_connection_url', '远程服务需要 HTTPS；本机服务可以使用回环地址');
  }
  return url.href;
}

function safeName(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '';
}

async function boundedJSON(response, signal) {
  if (!response.ok || !/\bjson\b/i.test(response.headers.get('content-type') || '')) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  let size = 0; const chunks = [];
  try {
    while (true) {
      if (signal.aborted) return null;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128_000) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
  finally { await reader.cancel().catch(() => {}); }
}

/** Agent cards are metadata, never identity proof or permission to cross origins. */
export async function inspectAgentCard(value, { token, fetch: fetcher = fetch, timeoutMs = 1800 } = {}) {
  const input = new URL(integrationURL(value));
  if (/\/(mcp|sse)\/?$/.test(input.pathname)) return null;
  const paths = input.pathname.endsWith('.json') ? [input.href] : [
    new URL('/.well-known/agent-card.json', input).href,
    new URL('/.well-known/agent.json', input).href,
  ];
  for (const path of paths) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetcher(path, { redirect: 'error', signal,
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      const card = await boundedJSON(response, signal);
      if (!card || typeof card !== 'object' || !safeName(card.name)) continue;
      const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
      const advertised = interfaces.find(item => ['JSONRPC', 'JSON-RPC', 'jsonrpc'].includes(item?.transport))?.url || card.url;
      if (typeof advertised !== 'string') continue;
      const endpoint = new URL(advertised, input);
      if (endpoint.origin !== input.origin) throw new APIError(400, 'cross_origin_agent_card', '服务提供了另一个网站的地址。请向服务方核对后，直接粘贴那个连接地址');
      return { type: 'a2a', name: safeName(card.name), url: integrationURL(endpoint.href),
        agentInfo: publicAgentInfo(card.agentInfo, { checkedAt: new Date().toISOString() }),
        discovery: { kind: 'agent_card', checkedAt: new Date().toISOString(), identityVerified: false } };
    } catch (error) {
      if (error instanceof APIError) throw error;
      // Absence or a bounded read failure can still be a valid MCP endpoint.
    }
  }
  return null;
}

export function presetConnection(id, presets = TOOL_PRESETS) {
  const item = presets.find(preset => preset.id === id);
  if (!item) throw new APIError(400, 'unknown_integration', '这个连接入口不可用，请刷新列表');
  return { name: item.name, type: item.type, url: integrationURL(item.url), presetId: item.id };
}
