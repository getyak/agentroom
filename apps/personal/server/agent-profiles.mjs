import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const piThinkingLevels = model => !model.reasoning ? ['off'] : THINKING_LEVELS.filter(level => model.thinkingLevelMap?.[level] !== null && (!['xhigh', 'max'].includes(level) || model.thinkingLevelMap?.[level] !== undefined));
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,159}$/.test(value);
const providerId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value);
export function validateConfiguration(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['modelMode', 'provider', 'model', 'thinking'].includes(key))) throw new Error('联系人配置包含不支持的选项');
  const modelMode = value.modelMode || 'follow', thinking = value.thinking || 'follow';
  if (!['follow', 'fixed'].includes(modelMode) || !['follow', ...THINKING_LEVELS].includes(thinking)) throw new Error('请选择支持的模型与思考配置');
  if (modelMode === 'fixed' && (!modelId(value.model) || !providerId(value.provider))) throw new Error('请填写有效的模型与提供商');
  return { modelMode, thinking, ...(modelMode === 'fixed' ? { provider: value.provider, model: value.model } : {}) };
}
async function boundedFile(path) {
  try { const s = await stat(path); return s.isFile() && s.size <= 524288 ? await readFile(path, 'utf8') : ''; } catch { return ''; }
}
const json = text => { try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const safeModel = value => modelId(value) ? value : null;

/** Explicit preview only; never load arbitrary paths or workspace instructions. */
export async function readPiIdentity({ home = homedir(), env = process.env } = {}) {
  const directory = env.PI_CODING_AGENT_DIR || join(home, '.pi/agent');
  const sources = [];
  for (const filename of ['SYSTEM.md', 'APPEND_SYSTEM.md']) {
    const text = (await boundedFile(join(directory, filename))).trim();
    if (text) sources.push({ filename, text });
  }
  const combined = sources.map(source => source.text).join('\n\n');
  return { instructions: combined.slice(0, 3000), sources: sources.map(source => source.filename), truncated: combined.length > 3000 };
}

/** Project only model metadata. Never read auth.json or return credentials/headers. */
export async function readAgentProfile(agentId, { home = homedir(), env = process.env } = {}) {
  let defaults = { provider: null, model: null, thinking: null }, models = [], modelThinkingLevels = {}, providers = [];
  let thinkingLevels = [], description = '', source = '本机默认配置';
  let guestCompatible;
  if (agentId === 'pi') {
    const directory = env.PI_CODING_AGENT_DIR || join(home, '.pi/agent');
    const [settingsText, modelsText] = await Promise.all([boundedFile(join(directory, 'settings.json')), boundedFile(join(directory, 'models.json'))]);
    const settings = json(settingsText), definitions = json(modelsText);
    defaults = { provider: providerId(settings.defaultProvider) ? settings.defaultProvider : null, model: safeModel(settings.defaultModel), thinking: THINKING_LEVELS.includes(settings.defaultThinkingLevel) ? settings.defaultThinkingLevel : 'medium' };
    for (const [key, value] of Object.entries(settings.modelThinkingLevels || {}).slice(0, 1000)) if (key.length <= 240 && THINKING_LEVELS.includes(value)) modelThinkingLevels[key] = value;
    for (const [provider, definition] of Object.entries(definitions.providers || {}).slice(0, 100)) {
      if (!providerId(provider) || !Array.isArray(definition?.models)) continue;
      providers.push(provider);
      for (const item of definition.models.slice(0, 1000)) if (modelId(item?.id)) models.push({ provider, id: item.id, name: typeof item.name === 'string' ? item.name.slice(0, 100) : item.id, reasoning: item.reasoning === true, thinkingLevels: piThinkingLevels(item) });
    }
    thinkingLevels = THINKING_LEVELS;
    description = 'Pi 的独立聊天身份';
    source = 'Pi 保存的启动默认值；终端临时切换需保存默认，或在此单独选择';
  } else if (agentId === 'codex') {
    const directory = env.CODEX_HOME || join(home, '.codex');
    const text = await boundedFile(join(directory, 'config.toml'));
    // Guest execution ignores user config. Do not silently drop a transport
    // override of the built-in provider and send to a different endpoint.
    guestCompatible = !/^\s*(?:\[\s*["']?model_providers\b|model_providers\s*=|profile\s*=)/m.test(text);
    const authStore = text.match(/^\s*cli_auth_credentials_store\s*=\s*["']([^"']+)["']/m)?.[1];
    if (authStore && authStore !== 'file') guestCompatible = false;
    const fields = body => {
      const result = {};
      for (const match of body.matchAll(/^\s*(model|model_provider|model_reasoning_effort|profile)\s*=\s*(["'])(.*?)\2\s*(?:#.*)?$/gm)) result[match[1]] = match[3];
      return result;
    };
    const sections = text.split(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/m);
    const values = fields(sections[0]);
    let unresolvedProfile = false;
    if (values.profile) {
      if (!providerId(values.profile)) unresolvedProfile = true;
      else {
        const at = sections.findIndex((value, i) => i % 2 === 1 && value === `profiles.${values.profile}`);
        if (at >= 0) Object.assign(values, fields(sections[at + 1] || ''));
        else {
          const overlay = await boundedFile(join(directory, `${values.profile}.config.toml`));
          if (!overlay || fields(overlay.split(/^\s*\[/m)[0]).profile) unresolvedProfile = true;
          else Object.assign(values, fields(overlay.split(/^\s*\[/m)[0]));
        }
      }
    }
    defaults = { provider: unresolvedProfile ? null : providerId(values.model_provider) ? values.model_provider : 'openai', model: unresolvedProfile ? null : safeModel(values.model), thinking: unresolvedProfile ? null : THINKING_LEVELS.includes(values.model_reasoning_effort) ? values.model_reasoning_effort : null };
    providers = [...new Set([defaults.provider || 'openai', ...[...text.matchAll(/^\s*\[model_providers\.([A-Za-z0-9_.-]+)\]/gm)].map(m => m[1])])];
    thinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh']; description = 'Codex 的独立聊天身份';
  } else if (agentId === 'claude') {
    const settings = json(await boundedFile(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json')));
    defaults = { provider: 'anthropic', model: safeModel(env.ANTHROPIC_MODEL || settings.env?.ANTHROPIC_MODEL || settings.model), thinking: ['low', 'medium', 'high', 'max'].includes(settings.effortLevel) ? settings.effortLevel : null };
    thinkingLevels = ['low', 'medium', 'high', 'max']; providers = ['anthropic']; description = 'Claude Code 的独立聊天身份';
  }
  const profile = { agentId, defaults, models, providers, thinkingLevels, modelThinkingLevels, description, source, ...(guestCompatible === undefined ? {} : { guestCompatible }) };
  return { ...profile, version: hash(profile) };
}

export function resolveExecution(profile, input = {}) {
  const config = validateConfiguration(input);
  const provider = config.modelMode === 'fixed' ? config.provider : profile.defaults.provider;
  const model = config.modelMode === 'fixed' ? config.model : profile.defaults.model;
  if (['codex', 'claude'].includes(profile.agentId) && (!provider || !model)) throw new Error('无法确认本机默认模型，请为联系人单独选择模型后再发送');
  const selected = profile.models.find(item => item.provider === provider && item.id === model);
  if (profile.agentId === 'pi' && (!provider || !model || !selected)) throw new Error('当前 Pi 模型不可用，请重新读取本机配置或选择一个可用模型');
  if (config.modelMode === 'fixed' && profile.providers.length && !profile.providers.includes(provider)) throw new Error('这个提供商不在本机模型配置中');
  let thinking = config.thinking === 'follow' ? profile.modelThinkingLevels?.[`${provider}/${model}`] || profile.defaults.thinking : config.thinking;
  if (selected?.reasoning === false) {
    if (config.thinking !== 'follow' && config.thinking !== 'off') throw new Error('当前模型不支持思考等级，请选择关闭或跟随模型');
    thinking = 'off';
  }
  if (['codex', 'claude'].includes(profile.agentId) && !thinking) throw new Error('无法确认默认思考深度，请在联系人配置中选择深度后再发送');
  if (thinking && !(selected?.thinkingLevels || profile.thinkingLevels).includes(thinking)) throw new Error('这个模型不支持所选思考等级，请重新选择深度');
  return { agentId: profile.agentId, provider, model, thinking, modelPolicy: config.modelMode, thinkingPolicy: config.thinking, configurationVersion: profile.version };
}

/** Watch only metadata filenames, never sessions, authentication or transcripts. */
export function watchAgentProfiles(onChange, { home = homedir(), env = process.env } = {}) {
  const watchers = []; let timer;
  for (const [directory, names] of [
    [env.PI_CODING_AGENT_DIR || join(home, '.pi/agent'), ['settings.json', 'models.json']],
    [env.CODEX_HOME || join(home, '.codex'), ['config.toml']],
    [env.CLAUDE_CONFIG_DIR || join(home, '.claude'), ['settings.json']],
  ]) {
    try {
      const watcher = watch(directory, (_event, filename) => {
        if (!names.includes(String(filename)) && !(names.includes('config.toml') && /^[A-Za-z0-9_.-]+\.config\.toml$/.test(String(filename)))) return;
        clearTimeout(timer); timer = setTimeout(onChange, 120); timer.unref();
      });
      watcher.on('error', () => {}); watcher.unref(); watchers.push(watcher);
    } catch { /* Explicit refresh still discovers a directory created later. */ }
  }
  return () => { clearTimeout(timer); for (const watcher of watchers) watcher.close(); };
}
