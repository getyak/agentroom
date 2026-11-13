#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const inventory = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
function listeningPorts(pid) {
  try { return execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (error) { if (error.status === 1) return ''; throw error; }
}

/** Find only this installed application's owned runtime; never attach a dev server. */
export async function findWorkspace({ executable, revision, processes = inventory(), listeners = listeningPorts }) {
  const rows = processes.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), executable: match[3] }] : [];
  });
  const roots = rows.filter(row => row.executable === executable);
  if (roots.length > 1) throw new Error('发现多个 AgentRoom 实例，请先结束隔离验收，再打开所需工作区。');
  if (!roots.length) throw new Error('未发现这份安装包的运行实例，请先打开 AgentRoom。');
  // utilityProcess.fork creates a direct child. Its descendants may be agent
  // tasks running unrelated same-build development servers with other data.
  const owned = new Set(rows.filter(row => row.parent === roots[0].pid).map(row => row.pid));
  for (const pid of owned) {
    const ports = [...new Set([...listeners(pid).matchAll(/^n127\.0\.0\.1:(\d+)$/gm)].map(match => Number(match[1])))];
    for (const port of ports) {
      const origin = `http://127.0.0.1:${port}`;
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
        if (!response.ok) { await response.body?.cancel(); continue; }
        const health = await response.json();
        if (health.ok === true && health.service === 'agentstudio-personal' && health.build?.ref === revision) return origin;
      } catch { /* A different owned helper may listen without serving the personal API. */ }
    }
  }
  throw new Error('当前桌面后台尚未就绪或构建不匹配，请在 AgentRoom 中检查后台状态后重试。');
}

async function main(args) {
  let app, printOnly = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') { console.log('Usage: node dev/open-personal-web.mjs [--app /absolute/AgentRoom.app] [--print-url]'); return; }
    if (args[index] === '--print-url') printOnly = true;
    else if (args[index] === '--app' && args[index + 1] && isAbsolute(args[index + 1])) app = args[++index];
    else throw new Error('使用 --app /绝对路径/AgentRoom.app 或 --print-url；--help 查看用法。');
  }
  if (process.platform !== 'darwin') throw new Error('此入口用于 macOS 桌面应用；服务器节点请使用节点连接入口。');
  const candidates = app ? [app] : [join(homedir(), 'Applications/AgentRoom.app'), '/Applications/AgentRoom.app'];
  const processes = inventory();
  const matches = [];
  for (const candidate of new Set(candidates.filter(existsSync).map(candidate => realpathSync(candidate)))) {
    const executable = realpathSync(join(candidate, 'Contents/MacOS/AgentRoom'));
    if (!processes.split('\n').some(line => line.match(/^\s*\d+\s+\d+\s+(.+)$/)?.[1] === executable)) continue;
    const info = JSON.parse(readFileSync(join(candidate, 'Contents/Resources/app/out/main/build-info.json'), 'utf8'));
    if (typeof info.revision !== 'string' || !info.revision) throw new Error('安装包缺少构建提交，请先更新 AgentRoom。');
    matches.push(await findWorkspace({ executable, revision: info.revision, processes }));
  }
  if (matches.length !== 1) throw new Error(matches.length ? '发现多个安装位置，请用 --app 明确选择。' : '请先打开已安装的 AgentRoom，再运行此入口。');
  if (!printOnly) execFileSync('/usr/bin/open', [matches[0]], { stdio: 'ignore' });
  console.log(matches[0]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
