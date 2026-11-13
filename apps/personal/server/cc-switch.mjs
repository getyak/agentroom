import { DatabaseSync } from 'node:sqlite';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLIENTS = [['codex', 'Codex'], ['claude', 'Claude Code'], ['pi', 'Pi'], ['gemini', 'Gemini CLI'], ['opencode', 'OpenCode']];
const TABLES = ['providers', 'mcp_servers', 'skills', 'prompts', 'profiles'];
const empty = status => ({ status, clients: [], profiles: null });
export const ccSwitchNotFound = () => empty('not_found');
const label = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 100) || '未命名扩展' : '未命名扩展';

/** Fixed, server-only metadata projection. No commands, URLs, secrets or prompt bodies are selected. */
export async function readCcSwitch({ home = homedir() } = {}) {
  const path = join(home, '.cc-switch', 'cc-switch.db');
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 128 * 1024 * 1024) return empty('unavailable');
  } catch (error) { return empty(error.code === 'ENOENT' ? 'not_found' : 'unavailable'); }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true, enableLoadExtension: false });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=80; BEGIN');
    const columns = new Map();
    for (const table of TABLES) {
      // Reject views: selecting a display field must not execute an arbitrary view projection.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        columns.set(table, new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name)));
    }
    const has = (table, names) => names.every(name => columns.get(table)?.has(name));
    const extensions = (table, id) => {
      const flag = `enabled_${id}`; // id and table are exclusively from the fixed catalogs above.
      if (!has(table, ['name', flag])) return null;
      const enabled = db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE "${flag}"=1`).get().n;
      const names = db.prepare(`SELECT substr(name,1,200) AS name FROM "${table}" WHERE "${flag}"=1 ORDER BY name LIMIT 50`).all().map(row => label(row.name));
      return { enabled, names, truncated: enabled > names.length };
    };
    const clients = CLIENTS.map(([id, name]) => {
      const providers = has('providers', ['app_type', 'is_current'])
        ? db.prepare('SELECT count(*) AS total, coalesce(sum(is_current=1),0) AS selected FROM providers WHERE app_type=?').get(id) : null;
      const prompts = has('prompts', ['app_type', 'enabled'])
        ? db.prepare('SELECT count(*) AS n FROM prompts WHERE app_type=? AND enabled=1').get(id).n : null;
      return { id, name, providers: providers ? { ...providers } : null, mcp: extensions('mcp_servers', id), skills: extensions('skills', id), prompts };
    });
    const profiles = columns.has('profiles') ? db.prepare('SELECT count(*) AS n FROM profiles').get().n : null;
    return { status: 'available', clients, profiles };
  } catch { return empty('unavailable'); }
  finally { if (db) { try { db.close(); } catch { /* Never expose database errors or local paths. */ } } }
}
