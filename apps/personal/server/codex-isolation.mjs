import { mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readAgentProfile } from './agent-profiles.mjs';

const transportOverrides = ['OPENAI_API_BASE', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'CHATGPT_BASE_URL', 'CODEX_OPENAI_BASE_URL', 'CODEX_CHATGPT_BASE_URL', 'CODEX_PROFILE', 'CODEX_CONFIG_PROFILE'];
const supportedRootFields = new Set(['model', 'model_provider', 'model_reasoning_effort', 'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'notify', 'service_tier', 'cli_auth_credentials_store']);
const isolatedTables = new Set(['analytics', 'apps', 'browser_use', 'computer_use', 'desktop', 'features', 'marketplaces', 'mcp_servers', 'permissions', 'plugins', 'projects', 'sandbox_workspace_write', 'tui']);

/** An isolated home can only preserve the built-in transport and these known user settings. */
export async function codexConversationTransport(deps) {
  if (transportOverrides.some(key => deps.env[key])) return null;
  const directory = deps.env.CODEX_HOME || join(deps.home, '.codex');
  const path = join(directory, 'config.toml');
  const info = await stat(path);
  if (!info.isFile() || info.size > 524288) return null;
  const config = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  const root = config.split(/^[\t ]*\[/m, 1)[0];
  if (/^[\t ]*["'][^\r\n]*[.=]/m.test(root)) return null;
  const fields = [...root.matchAll(/^[\t ]*([A-Za-z0-9_-]+)[\t ]*(?=[.=])/gm)];
  if (fields.some(([,key]) => !supportedRootFields.has(key) && !isolatedTables.has(key))) return null;
  const tables = [...config.matchAll(/^[\t ]*\[{1,2}[\t ]*([^\]\r\n]*)/gm)];
  if (tables.some(([,name]) => !isolatedTables.has(name.match(/^[A-Za-z0-9_-]+/)?.[0]))) return null;
  const serviceTier = root.match(/^[\t ]*service_tier[\t ]*=[\t ]*(["'])([a-zA-Z0-9_-]{1,32})\1[\t ]*(?:#[^\r\n]*)?$/m)?.[2];
  if (fields.some(([,key]) => key === 'service_tier') && !serviceTier) return null;
  return { ...(serviceTier ? {serviceTier} : {}) };
}

// A private empty CLI home excludes global AGENTS as well as config/memory.
// Only auth.json is linked to the existing owning account, never copied. The
// supported CLI's file auth writer follows that link, so normal token refresh
// retains the same account/store. Keep the version gate in local-agents.mjs.
export async function codexAuthSource(deps = {}) {
  if (process.platform === 'win32') throw new Error('当前系统暂不能建立隔离的访客认证');
  const sourceEnv = deps.env || process.env, source = join(sourceEnv.CODEX_HOME || join(deps.home || homedir(), '.codex'), 'auth.json');
  if (['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'].some(key => sourceEnv[key])) throw new Error('隔离执行需要明确的文件认证和默认传输；没有选择其他账号，也没有忽略环境变量中的服务地址');
  if ((await readAgentProfile('codex', deps)).guestCompatible === false) throw new Error('访客模式暂不支持当前 Codex 配置；没有切换配置');
  const info = await stat(source); if (!info.isFile() || info.size > 65536 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('访客模式需要私有的当前认证文件');
  const original = JSON.parse(await readFile(source, 'utf8'));
  const key = typeof original.OPENAI_API_KEY === 'string' && Boolean(original.OPENAI_API_KEY), tokens = original.tokens && ['access_token', 'id_token', 'account_id'].every(key => typeof original.tokens[key] === 'string' && original.tokens[key]);
  const mode = original.auth_mode || (key && !tokens ? 'apikey' : tokens && !key ? 'chatgpt' : null);
  if (key && tokens || !((mode === 'apikey' && key) || (mode === 'chatgpt' && tokens))) throw new Error('访客模式暂不支持当前认证存储；请在本机核查，不会切换账号');
  return realpath(source);
}

export async function guestCodexSession(workspace, deps = {}) {
  const source = await codexAuthSource(deps);
  const sourceEnv = deps.env || process.env;
  const home = await mkdtemp(join(workspace, 'guest-home-'));
  const close = () => rm(home, { recursive: true, force: true });
  try {
    await symlink(source, join(home, 'auth.json'));
    const allowed = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
    const env = Object.fromEntries(Object.entries(sourceEnv).filter(([name]) => allowed.has(name)));
    return { deps: { ...deps, home, env: { ...env, HOME: home, CODEX_HOME: home } }, close };
  } catch (error) { await close(); throw error; }
}
