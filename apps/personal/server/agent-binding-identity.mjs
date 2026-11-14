import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { digest, APIError } from './store.mjs';
async function bounded(path){try{const info=await stat(path);if(!info.isFile()||info.size>524288)throw new Error();return await readFile(path,'utf8');}catch{throw new APIError(409,'binding_identity_unknown','无法确认所选助手的认证与传输配置，请在本机检查后重试');}}
function subject(token){try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')).sub||null;}catch{return null;}}
/** Private hash only. Credentials and endpoint material never leave the host. */
export async function agentBindingIdentity(agentId,deps={}){
 const env=deps.env||process.env,home=deps.home||homedir();
 if(agentId==='codex'){
  if(['CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_ORG_ID','OPENAI_PROJECT_ID'].some(k=>env[k]))throw new APIError(409,'binding_transport_unsupported','隔离配置暂不支持当前环境变量中的认证或服务地址；没有切换账号或忽略端点');
  const directory=env.CODEX_HOME||join(home,'.codex');let auth;try{auth=JSON.parse(await bounded(join(directory,'auth.json')));}catch{throw new APIError(409,'binding_identity_unknown','当前认证文件无法安全解析，请在本机核查');}const config=await bounded(join(directory,'config.toml'));
  const identity=auth.OPENAI_API_KEY?{type:'api_key',keyHash:digest(auth.OPENAI_API_KEY)}:{type:auth.auth_mode||'chatgpt',accountId:auth.tokens?.account_id||null,idTokenSubject:subject(auth.tokens?.id_token)};
  return digest(JSON.stringify({identity,config}));
 }
 if(agentId==='pi'){
  const directory=env.PI_CODING_AGENT_DIR||join(home,'.pi/agent');
  // Opaque OAuth credentials may rotate; conservative invalidation requires a new test.
  return digest(JSON.stringify(await Promise.all(['auth.json','settings.json','models.json'].map(name=>bounded(join(directory,name))))));
 }
 throw new APIError(409,'binding_identity_unsupported','这个助手暂不支持隔离配置身份核对');
}
