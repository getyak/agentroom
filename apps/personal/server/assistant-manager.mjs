import { access, mkdir, readFile, writeFile, rename, realpath, stat, lstat, mkdtemp, rm, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename, delimiter, isAbsolute, relative, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn as nativeSpawn } from 'node:child_process';
import { AssistantManagerError, fail, boundedDownload, safeRelative, webURL, runChild, installBinary, npmExecutable, ownedExecutable, ownedDirectory, installerEnvironment, installedNpmOwner, processGroupAlive } from './assistant-install.mjs';
export { AssistantManagerError } from './assistant-install.mjs';
export const ASSISTANT_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const DAY = 24 * 60 * 60 * 1000;
const NATIVE = Object.freeze([{
  id: 'codex',
  name: 'Codex',
  package: '@openai/codex',
  bin: 'codex',
  repository: 'https://github.com/openai/codex',
  protocol: 'cli',
  args: []
}, {
  id: 'claude',
  name: 'Claude Code',
  package: '@anthropic-ai/claude-code',
  bin: 'claude',
  repository: 'https://github.com/anthropics/claude-code',
  protocol: 'cli',
  args: []
}, {
  id: 'pi',
  name: 'Pi',
  package: '@mariozechner/pi-coding-agent',
  bin: 'pi',
  repository: 'https://github.com/badlogic/pi-mono',
  protocol: 'cli',
  args: []
}, {
  id: 'gemini',
  name: 'Gemini CLI',
  package: '@google/gemini-cli',
  bin: 'gemini',
  repository: 'https://github.com/google-gemini/gemini-cli',
  protocol: 'acp',
  args: ['--experimental-acp']
}, {
  id: 'opencode',
  name: 'OpenCode',
  package: 'opencode-ai',
  bin: 'opencode',
  repository: 'https://github.com/anomalyco/opencode',
  protocol: 'acp',
  args: ['acp']
}]);
const safeId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(value);
const safeVersion = value => typeof value === 'string' && value.length <= 100 && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value);
const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max) : '';
const safeArgs = value => value === undefined ? [] : Array.isArray(value) && value.length <= 32 && value.every(item => typeof item === 'string' && item.length <= 1024 && !/[\u0000\r\n]/.test(item)) ? value : null;
const packageName = value => typeof value === 'string' && value.length < 200 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
const versionOf = value => value.match(/\b(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/)?.[1] || null;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const atTime = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
function newer(a, b) {
  if (!safeVersion(a) || !safeVersion(b)) return false;
  const parse = value => {
    const withoutBuild = value.split('+')[0],
      dash = withoutBuild.indexOf('-');
    return {
      core: (dash < 0 ? withoutBuild : withoutBuild.slice(0, dash)).split('.').map(BigInt),
      pre: dash < 0 ? null : withoutBuild.slice(dash + 1).split('.')
    };
  };
  const left = parse(a),
    right = parse(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i];
  if (!left.pre || !right.pre) return !left.pre && Boolean(right.pre);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i],
      y = right.pre[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    if (x === y) continue;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y);
    if (xn !== yn) return !xn;
    return x > y;
  }
  return false;
}
function target(platform, arch) {
  return `${platform === 'win32' ? 'windows' : platform}-${arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch}`;
}
function distribution(agent, platform, arch) {
  const dist = agent.distribution;
  if (!dist || typeof dist !== 'object') return {
    reason: '目录未提供可安装版本'
  };
  const npx = dist.npx;
  if (npx) {
    const args = safeArgs(npx.args);
    if (!args || typeof npx.package !== 'string') return null;
    const at = npx.package.lastIndexOf('@');
    const pkg = at > 0 ? npx.package.slice(0, at) : npx.package,
      version = at > 0 ? npx.package.slice(at + 1) : agent.version;
    if (!packageName(pkg) || version !== agent.version || !safeVersion(version)) return null;
    return {
      plan: {
        type: 'npm',
        package: pkg,
        version,
        args,
        protocol: 'acp'
      }
    };
  }
  const binary = dist.binary?.[target(platform, arch)];
  if (binary) {
    const cmd = safeRelative(binary.cmd),
      args = safeArgs(binary.args),
      archive = webURL(binary.archive);
    if (!cmd || !args || !archive || binary.env && Object.keys(binary.env).length) return null;
    if (!/^[a-fA-F0-9]{64}$/.test(binary.sha256 || '')) return {
      reason: '这个安装包未提供完整性校验，暂不能自动安装'
    };
    const path = new URL(archive).pathname;
    if (/\.(zip|bz2|tbz2|xz|dmg|pkg|deb|rpm|msi|appimage)$/i.test(path)) return {
      reason: '这个安装包格式暂不支持，可从项目主页安装'
    };
    return {
      plan: {
        type: 'binary',
        archive,
        sha256: binary.sha256.toLowerCase(),
        cmd,
        args,
        version: agent.version,
        protocol: 'acp'
      }
    };
  }
  if (dist.uvx) return {
    reason: '这个助手需要 Python/uv 安装，暂请从项目主页安装'
  };
  return {
    reason: '目录暂未提供适合这台电脑的安装包'
  };
}
function cleanRegistry(body, platform, arch) {
  if (!body || !Array.isArray(body.agents) || body.agents.length > 500) fail(502, 'invalid_registry', '官方目录格式暂不可用');
  const seen = new Set(),
    entries = [];
  for (const item of body.agents) {
    if (!item || !safeId(item.id) || !safeVersion(item.version) || !text(item.name) || seen.has(item.id)) continue;
    const dist = distribution(item, platform, arch);
    if (!dist) continue;
    seen.add(item.id);
    entries.push({
      id: `acp_${item.id}`,
      localAgentId: `acp_${item.id}`,
      name: text(item.name, 100),
      description: text(item.description, 500),
      kind: 'acp',
      repository: webURL(item.repository) || webURL(item.website),
      latestVersion: item.version,
      ...dist
    });
  }
  return entries;
}
function publicOperation(op) {
  return Object.fromEntries(Object.entries(op).filter(([key]) => !key.startsWith('_')));
}

/** Owns only AgentRoom-managed tools. Vendor profiles, credentials and global installs are read-only. */
export class AssistantManager {
  constructor(options = {}) {
    if (typeof options.dataDir !== 'string' || !isAbsolute(options.dataDir)) throw Error('AssistantManager requires an absolute dataDir');
    this.options = options;
    this.home = resolve(options.home || homedir());
    this.env = {
      ...(options.env || process.env)
    };
    this.spawn = options.spawn || nativeSpawn;
    this.fetch = options.fetch || globalThis.fetch;
    this.clock = options.now || Date.now;
    this.lastAttemptAt = 0;
    this.root = join(resolve(options.dataDir), 'assistants');
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.commands = options.commands || {};
    this.state = {
      schema: 1,
      catalog: {
        checkedAt: null,
        native: {},
        registry: []
      },
      active: {},
      operations: [],
      requests: {}
    };
    this.source = {
      status: 'unavailable',
      checkedAt: null
    };
    this.queue = Promise.resolve();
    this.acceptance = Promise.resolve();
    this.persistence = Promise.resolve();
    this.controllers = new Set();
    this.children = new Set();
    this.closedChildren = new WeakSet();
    this.childJobs = new WeakMap();
    this.probes = new Map();
    this.closed = false;
    this.storageAvailable = false;
    this.ready = this.load().catch(() => {
      this.storageAvailable = false;
      this.source = {
        status: 'unavailable',
        checkedAt: null,
        error: '助手管理目录暂不可写，本机已有助手仍可使用'
      };
    });
    this.timer = setInterval(() => {
      if (!this.closed && this.shouldRefresh()) this.refreshInBackground();
    }, 60 * 60 * 1000);
    this.timer.unref();
  }
  now() {
    return Number(this.clock());
  }
  stamp() {
    return new Date(this.now()).toISOString();
  }
  notify() {
    try {
      this.options.notify?.({
        kind: 'assistant_management'
      });
    } catch {}
  }
  async load() {
    await mkdir(this.root, {
      recursive: true,
      mode: 0o700
    });
    if ((await lstat(this.root)).isSymbolicLink()) throw Error('Assistant directory cannot be a symlink');
    await chmod(this.root, 0o700);
    this.storageAvailable = true;
    try {
      const file = join(this.root, 'state.json');
      if ((await lstat(file)).isSymbolicLink() || (await stat(file)).size > 8 * 1024 * 1024) throw Error();
      const stored = JSON.parse(await readFile(file, 'utf8'));
      if (stored.schema !== 1 || !stored.active || typeof stored.active !== 'object' || Array.isArray(stored.active) || !Array.isArray(stored.operations) || stored.operations.some(op => !op || typeof op !== 'object' || typeof op.id !== 'string' || !safeId(op.agentId) || !['queued', 'running', 'succeeded', 'failed', 'interrupted'].includes(op.state)) || !stored.requests || typeof stored.requests !== 'object' || Array.isArray(stored.requests)) throw Error();
      // Revalidate the cached registry through the same parser; persist no remote instructions.
      const cached = stored.catalog || {};
      const clean = [];
      for (const entry of cached.registry || []) {
        if (!safeId(entry.id) || !safeVersion(entry.latestVersion) || !entry.id.startsWith('acp_')) continue;
        const plan = this.validatePlan(entry.plan);
        if (!plan && !entry.reason) continue;
        clean.push({
          ...entry,
          ...(plan ? {
            plan
          } : {
            plan: undefined
          })
        });
      }
      this.state = {
        schema: 1,
        catalog: {
          checkedAt: atTime(cached.checkedAt) ? cached.checkedAt : null,
          native: cached.native && typeof cached.native === 'object' ? cached.native : {},
          registry: clean
        },
        active: Object.fromEntries(Object.entries(stored.active).filter(([id, entry]) => safeId(id) && entry && typeof entry === 'object' && !Array.isArray(entry))),
        operations: stored.operations.slice(-200),
        requests: stored.requests
      };
      for (const op of this.state.operations) if (['queued', 'running'].includes(op.state)) {
        op.state = 'interrupted';
        op.progress = '上次安装已中断，原版本保持可用';
        op.error = '安装中断后不会自动重试';
        op.updatedAt = this.stamp();
        if (op._pid && (this.processExists(op._pid) || processGroupAlive(op._pid))) {
          op._stopUnconfirmed = true;
          op.error = '上次安装进程是否退出尚未确认';
        }
      }
      this.source = {
        status: this.state.catalog.checkedAt ? 'cached' : 'unavailable',
        checkedAt: this.state.catalog.checkedAt
      };
      await this.persist();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.source = {
          status: 'unavailable',
          checkedAt: null,
          error: '本机助手目录缓存不可用，重新检查即可恢复'
        };
      }
    }
  }
  validatePlan(plan) {
    if (!plan || !safeVersion(plan.version) || !['cli', 'acp'].includes(plan.protocol) || !safeArgs(plan.args)) return null;
    if (plan.type === 'npm' && packageName(plan.package)) return {
      type: 'npm',
      package: plan.package,
      version: plan.version,
      bin: typeof plan.bin === 'string' ? plan.bin : undefined,
      args: safeArgs(plan.args),
      protocol: plan.protocol
    };
    if (plan.type === 'binary' && webURL(plan.archive) && /^[a-f0-9]{64}$/i.test(plan.sha256 || '') && safeRelative(plan.cmd)) return {
      type: 'binary',
      archive: webURL(plan.archive),
      sha256: plan.sha256,
      cmd: safeRelative(plan.cmd),
      args: safeArgs(plan.args),
      version: plan.version,
      protocol: plan.protocol
    };
    return null;
  }
  async persist() {
    const json = JSON.stringify(this.state);
    this.persistence = this.persistence.catch(() => {}).then(async () => {
      const temp = join(this.root, `state-${randomUUID()}.tmp`);
      try {
        await ownedDirectory(this.root, []);
        await writeFile(temp, json, {
          mode: 0o600,
          flag: 'wx'
        });
        await rename(temp, join(this.root, 'state.json'));
      } finally {
        await rm(temp, {
          force: true
        }).catch(() => {});
      }
    });
    return this.persistence;
  }
  async findCommand(id) {
    const definition = NATIVE.find(a => a.id === id),
      override = Object.hasOwn(this.commands, id) ? this.commands[id] : this.env[`AGENTSTUDIO_${id.toUpperCase()}_BIN`];
    const name = override ?? definition?.bin ?? id;
    if (typeof name !== 'string' || !name || /[\u0000\r\n]/.test(name)) return null;
    const dirs = [...(this.env.PATH || '').split(delimiter).filter(isAbsolute), join(this.home, '.local/bin'), join(this.home, 'bin'), join(this.home, 'Library/pnpm'), join(this.home, '.volta/bin'), join(this.home, '.bun/bin')];
    if (this.home === homedir()) dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
    const candidates = isAbsolute(name) || name.includes('/') ? [resolve(name)] : [...new Set(dirs)].map(dir => join(dir, name));
    for (const path of candidates) try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return await realpath(path);
    } catch {}
    return null;
  }
  async commandLaunch(command, id, protocol, args) {
    const cached = this.probes.get(command);
    let version = cached && cached.expires > this.now() ? cached.version : undefined;
    if (version === undefined) {
      try {
        const result = await runChild(command, ['--version'], {
          spawn: this.spawn,
          env: this.env,
          cwd: this.home,
          timeoutMs: 3000,
          maxBytes: 32768,
          capture: true
        });
        version = result.code === 0 ? versionOf(result.text) : null;
      } catch {
        version = null;
      }
      this.probes.set(command, {
        version,
        expires: this.now() + 60000
      });
    }
    return {
      command,
      args: [...args],
      version,
      protocol,
      agentId: id
    };
  }
  async systemLaunch(id) {
    const native = NATIVE.find(a => a.id === id);
    if (!native) return null;
    const command = await this.findCommand(id);
    return command ? this.commandLaunch(command, id, native.protocol, native.args) : null;
  }
  async registrySystemLaunch(id) {
    const entry = this.state.catalog.registry.find(item => item.id === id),
      plan = this.validatePlan(entry?.plan);
    // Registry binary basenames do not establish ownership of an arbitrary system binary.
    if (!plan || plan.type !== 'npm') return null;
    const bin = plan.bin || plan.package.split('/').at(-1),
      command = await this.findCommand(bin);
    if (!command) return null;
    const owner = await installedNpmOwner(command, plan.package);
    if (!owner || !safeVersion(owner.version)) return null;
    return {
      command,
      args: [...plan.args],
      version: owner.version,
      protocol: 'acp',
      agentId: id
    };
  }
  async managedLaunch(id) {
    const active = this.state.active[id];
    if (!active || !safeVersion(active.version) || !safeRelative(active.directory) || !safeRelative(active.command) || !safeArgs(active.args) || !['cli', 'acp'].includes(active.protocol)) return null;
    const expected = join('versions', id) + sep;
    if (!active.directory.startsWith(expected) || !active.command.startsWith(active.directory + sep)) return null;
    try {
      const directory = await ownedDirectory(this.root, active.directory.split(sep)),
        command = await ownedExecutable(directory, join(this.root, active.command));
      return {
        command,
        args: [...active.args],
        version: active.version,
        protocol: active.protocol,
        agentId: id
      };
    } catch {
      return null;
    }
  }
  async launch(localAgentId) {
    await this.ready;
    if (!safeId(localAgentId)) return null;
    return (await this.managedLaunch(localAgentId)) || (await this.systemLaunch(localAgentId)) || (await this.registrySystemLaunch(localAgentId));
  }
  recordStateError() {
    this.source = {
      ...this.source,
      error: '助手状态暂未保存，请检查磁盘后重试'
    };
    this.notify();
  }
  persistBackground(onFailure) {
    void this.persist().catch(() => {
      this.recordStateError();
      try {
        onFailure?.();
      } catch {}
    });
  }
  refreshInBackground() {
    void this.refresh().catch(() => this.recordStateError());
  }
  releaseFinishedChildren() {
    let changed = false;
    for (const child of this.children) {
      if (this.closedChildren.has(child) && (!child.pid || !processGroupAlive(child.pid))) {
        this.children.delete(child);
        const op = this.childJobs.get(child);
        if (op) {
          delete op._pid;
          delete op._stopUnconfirmed;
        }
        changed = true;
      }
    }
    if (changed) this.persistBackground();
  }
  trackInstallerChild(op, controller, child) {
    if (!child) {
      this.releaseFinishedChildren();
      return;
    }
    this.children.add(child);
    this.childJobs.set(child, op);
    if (Number.isInteger(child.pid) && child.pid > 0) op._pid = child.pid;
    this.persistBackground(() => controller.abort(new AssistantManagerError(503, 'state_write_failed', '安装状态暂未保存，已停止这次安装')));
    child.once('close', () => {
      this.closedChildren.add(child);
      this.releaseFinishedChildren();
      this.notify();
    });
  }
  shouldRefresh() {
    return this.now() - atTime(this.state.catalog.checkedAt) >= DAY && this.now() - this.lastAttemptAt >= 5 * 60 * 1000;
  }
  async refresh() {
    await this.ready;
    if (this.closed) return;
    if (this.refreshing) return this.refreshing;
    this.lastAttemptAt = this.now();
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    timeout.unref();
    const run = (async () => {
      const next = structuredClone(this.state.catalog);
      let succeeded = 0,
        failed = 0;
      const jobs = [async () => {
        const raw = await boundedDownload(this.fetch, ASSISTANT_REGISTRY_URL, {
          signal: controller.signal
        });
        next.registry = cleanRegistry(JSON.parse(raw.toString('utf8')), this.platform, this.arch);
        succeeded++;
      }, ...NATIVE.map(item => async () => {
        const raw = await boundedDownload(this.fetch, `https://registry.npmjs.org/${encodeURIComponent(item.package)}/latest`, {
          signal: controller.signal
        });
        const metadata = JSON.parse(raw.toString('utf8'));
        if (metadata.name !== item.package || !safeVersion(metadata.version)) throw Error('invalid package');
        next.native[item.id] = {
          version: metadata.version
        };
        succeeded++;
      })];
      let cursor = 0;
      await Promise.all(Array.from({
        length: 2
      }, async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor++];
          try {
            await job();
          } catch {
            failed++;
          }
        }
      }));
      if (this.closed) return;
      if (succeeded) {
        if (!failed) next.checkedAt = this.stamp();
        this.state.catalog = next;
        this.source = {
          status: failed ? 'cached' : 'fresh',
          checkedAt: next.checkedAt,
          ...(failed ? {
            error: '部分官方版本暂未更新，已保留上次信息'
          } : {})
        };
        await this.persist();
      } else this.source = {
        status: this.state.catalog.checkedAt ? 'cached' : 'unavailable',
        checkedAt: this.state.catalog.checkedAt,
        error: '暂时无法更新官方目录，已保留本机助手和缓存'
      };
    })().finally(() => {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      this.refreshing = null;
      this.notify();
    });
    this.refreshing = run;
    return run;
  }
  async snapshot({
    refresh = false,
    background = true
  } = {}) {
    await this.ready;
    if (refresh) await this.refresh();else if (background && !this.refreshing && this.shouldRefresh()) this.refreshInBackground();
    const npm = await this.findCommand('npm');
    const native = await Promise.all(NATIVE.map(async item => {
      const managed = await this.managedLaunch(item.id),
        launch = managed || (await this.systemLaunch(item.id)),
        latest = this.state.catalog.native[item.id]?.version;
      return {
        id: item.id,
        localAgentId: item.id,
        name: item.name,
        description: '沿用本机账号与配置的助手',
        kind: 'native',
        installed: Boolean(launch),
        installedVersion: launch?.version || null,
        latestVersion: safeVersion(latest) ? latest : null,
        updateAvailable: Boolean(launch && newer(latest, launch.version)),
        installSupported: Boolean(this.storageAvailable && npm && safeVersion(latest)),
        source: managed ? 'managed' : launch ? 'system' : null,
        path: launch?.command || null,
        repository: item.repository,
        ...(!npm ? {
          reason: '安装或升级需要本机 Node.js/npm'
        } : !latest ? {
          reason: '正在检查官方最新版本'
        } : {})
      };
    }));
    const registryEntries = [...this.state.catalog.registry];
    for (const [id, active] of Object.entries(this.state.active)) {
      if (id.startsWith('acp_') && safeId(id) && !registryEntries.some(item => item.id === id)) {
        registryEntries.push({
          id,
          name: text(active.entry?.name, 100) || id.slice(4),
          description: text(active.entry?.description, 500),
          repository: webURL(active.entry?.repository),
          latestVersion: null,
          reason: '这个助手已不在最新目录中，本机已安装版本仍会保留'
        });
      }
    }
    const acp = await Promise.all(registryEntries.map(async item => {
      const managed = await this.managedLaunch(item.id),
        launch = managed || (await this.registrySystemLaunch(item.id)),
        plan = this.validatePlan(item.plan);
      return {
        id: item.id,
        localAgentId: item.id,
        name: item.name,
        description: item.description,
        kind: 'acp',
        installed: Boolean(launch),
        installedVersion: launch?.version || null,
        latestVersion: item.latestVersion,
        updateAvailable: Boolean(launch && newer(item.latestVersion, launch.version)),
        installSupported: Boolean(this.storageAvailable && plan && (plan.type !== 'npm' || npm)),
        source: managed ? 'managed' : launch ? 'system' : null,
        path: launch?.command || null,
        repository: item.repository || null,
        ...(item.reason ? {
          reason: item.reason
        } : plan?.type === 'npm' && !npm ? {
          reason: '安装这个助手需要本机 Node.js/npm'
        } : {})
      };
    }));
    return {
      checkedAt: this.stamp(),
      source: {
        ...this.source,
        refreshing: Boolean(this.refreshing)
      },
      entries: [...native, ...acp],
      operations: this.state.operations.map(publicOperation)
    };
  }
  descriptor(id) {
    const native = NATIVE.find(item => item.id === id);
    if (native) {
      const version = this.state.catalog.native[id]?.version;
      return safeVersion(version) ? {
        type: 'npm',
        package: native.package,
        bin: native.bin,
        version,
        args: [...native.args],
        protocol: native.protocol
      } : null;
    }
    return this.validatePlan(this.state.catalog.registry.find(item => item.id === id)?.plan);
  }
  start(input = {}) {
    const request = this.acceptance.catch(() => {}).then(() => this.accept(input));
    this.acceptance = request.catch(() => {});
    return request;
  }
  async accept({
    agentId,
    action,
    clientId,
    expectedVersion
  } = {}) {
    await this.ready;
    if (this.closed) fail(503, 'manager_closed', '助手管理已停止');
    if (!this.storageAvailable) fail(503, 'storage_unavailable', '助手管理目录暂不可写，请检查后再安装');
    if (!safeId(agentId) || !['install', 'update'].includes(action) || typeof clientId !== 'string' || !clientId || clientId.length > 128 || /[\u0000\r\n]/.test(clientId)) fail(400, 'invalid_install', '请选择助手和安装操作');
    if (expectedVersion !== undefined && !safeVersion(expectedVersion)) fail(400, 'invalid_version', '请选择目录中显示的版本');
    const fingerprint = hash({
        agentId,
        action,
        expectedVersion: expectedVersion ?? null
      }),
      existing = this.state.requests[clientId];
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail(409, 'request_conflict', '这次安装请求内容已变化，请重新发起');
      const op = this.state.operations.find(item => item.id === existing.operationId);
      if (op) return publicOperation(op);
      fail(409, 'request_expired', '这次安装记录已归档，请重新发起');
    }
    let plan = this.descriptor(agentId);
    if (!plan) {
      await this.refresh();
      plan = this.descriptor(agentId);
    }
    if (!plan) fail(409, 'install_unsupported', '这个助手暂不能自动安装，请查看项目主页或重新检查目录');
    if (expectedVersion !== undefined && expectedVersion !== plan.version) fail(409, 'version_changed', '目录版本已更新，请重新检查后再安装');
    if (plan.type === 'npm' && !(await this.findCommand('npm'))) fail(409, 'npm_missing', '请先安装 Node.js/npm，再安装这个助手');
    if (this.state.operations.some(op => op.agentId === agentId && ['queued', 'running'].includes(op.state))) fail(409, 'install_in_progress', '这个助手正在安装或升级');
    if (this.closed) fail(503, 'manager_closed', '助手管理已停止');
    const entry = this.state.catalog.registry.find(item => item.id === agentId);
    const op = {
      id: `assistant_${randomUUID()}`,
      agentId,
      action,
      state: 'queued',
      version: plan.version,
      progress: '等待安装',
      createdAt: this.stamp(),
      updatedAt: this.stamp(),
      _plan: plan,
      ...(entry ? {
        _entry: {
          name: entry.name,
          description: entry.description,
          repository: entry.repository
        }
      } : {})
    };
    const previousOperations = this.state.operations;
    this.state.operations = [...previousOperations, op].slice(-200);
    this.state.requests[clientId] = {
      fingerprint,
      operationId: op.id
    };
    try {
      await this.persist();
    } catch (error) {
      this.state.operations = previousOperations;
      delete this.state.requests[clientId];
      throw error;
    }
    this.notify();
    this.queue = this.queue.catch(() => {}).then(() => this.install(op)).catch(() => {
      op.state = 'failed';
      op.progress = '安装状态未能保存，原版本保持可用';
      op.error = '请检查磁盘后重试';
      op.updatedAt = this.stamp();
      this.recordStateError();
    });
    return publicOperation(op);
  }
  async install(op) {
    if (this.closed) {
      op.state = 'interrupted';
      op.progress = '安装已停止';
      op.updatedAt = this.stamp();
      await this.persist();
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    let timedOut = false;
    const installTimeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new AssistantManagerError(504, 'install_timeout', '安装超时，请稍后重试'));
    }, Math.min(300000, Math.max(50, Number(this.options.installTimeoutMs) || 300000)));
    installTimeout.unref();
    let staging;
    try {
      const plan = this.validatePlan(op._plan);
      if (!plan) fail(400, 'invalid_plan', '安装信息已失效，请刷新目录');
      op.state = 'running';
      op.progress = '准备独立版本目录';
      op.updatedAt = this.stamp();
      await this.persist();
      this.notify();
      const stagingRoot = await ownedDirectory(this.root, ['staging'], {
        create: true
      });
      staging = await mkdtemp(join(stagingRoot, `${op.agentId}-`));
      op._staging = staging;
      op.progress = plan.type === 'npm' ? '正在安装选定版本…' : '正在下载并校验安装包…';
      op.updatedAt = this.stamp();
      await this.persist();
      this.notify();
      let command;
      if (plan.type === 'npm') {
        const npm = await this.findCommand('npm');
        if (!npm) fail(409, 'npm_missing', '本机 npm 已不可用，请重新检查');
        const installEnv = await installerEnvironment(this.root, this.env);
        const result = await runChild(npm, ['install', '--prefix', staging, '--no-audit', '--no-fund', '--save-exact', `${plan.package}@${plan.version}`], {
          spawn: this.spawn,
          env: installEnv,
          cwd: staging,
          signal: controller.signal,
          onChild: child => this.trackInstallerChild(op, controller, child)
        });
        if (result.code !== 0) fail(503, 'install_failed', '安装未完成，原有助手和账号配置保持不变');
        command = await npmExecutable(staging, plan);
      } else command = await installBinary(plan, staging, {
        fetch: this.fetch,
        signal: controller.signal
      });
      if (controller.signal.aborted || this.closed) fail(409, 'install_interrupted', '安装已停止');
      const directory = join('versions', op.agentId, `${plan.version}-${hash(plan).slice(0, 12)}`),
        final = join(this.root, directory),
        relativeCommand = relative(staging, command);
      if (!safeRelative(relativeCommand)) fail(400, 'invalid_executable', '安装结果不可用');
      await ownedDirectory(this.root, ['versions', op.agentId], {
        create: true
      });
      try {
        await rename(staging, final);
        staging = null;
        delete op._staging;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        await ownedDirectory(this.root, directory.split(sep));
        await ownedExecutable(final, join(final, relativeCommand));
      }
      await ownedDirectory(this.root, directory.split(sep));
      command = await ownedExecutable(final, join(final, relativeCommand));
      const previousActive = this.state.active[op.agentId];
      this.state.active[op.agentId] = {
        directory,
        command: join(directory, relativeCommand),
        args: plan.args,
        version: plan.version,
        protocol: plan.protocol,
        ...(op._entry ? {
          entry: op._entry
        } : {})
      };
      op.state = 'succeeded';
      op.progress = '已安装，可继续添加联系人';
      op.updatedAt = this.stamp();
      try {
        await this.persist();
      } catch (error) {
        // A failed manifest write must not select a new version only in memory.
        if (previousActive) this.state.active[op.agentId] = previousActive;else delete this.state.active[op.agentId];
        throw error;
      }
      this.probes.clear();
    } catch (error) {
      op.state = this.closed || controller.signal.aborted && !timedOut ? 'interrupted' : 'failed';
      op.progress = op.state === 'interrupted' ? '安装已中断，原版本保持可用' : '安装未完成，原版本保持可用';
      if (error?.code === 'stop_unconfirmed') op._stopUnconfirmed = true;
      op.error = timedOut ? '安装超时，请稍后重试' : error instanceof AssistantManagerError ? error.message : '安装未完成，请重新检查后重试';
      op.updatedAt = this.stamp();
      await this.persist();
    } finally {
      clearTimeout(installTimeout);
      this.controllers.delete(controller);
      if (staging && !op._stopUnconfirmed) {
        try {
          await ownedDirectory(this.root, relative(this.root, staging).split(sep));
          await rm(staging, {
            recursive: true,
            force: true
          });
        } catch {/* Never follow a substituted directory link during cleanup. */}
        delete op._staging;
      }
      this.notify();
    }
  }
  processExists(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  }
  hasPendingOperations() {
    this.releaseFinishedChildren();
    return this.children.size > 0 || this.state.operations.some(op => ['queued', 'running'].includes(op.state) || op._stopUnconfirmed && (this.processExists(op._pid) || processGroupAlive(op._pid)));
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    this.closing = (async () => {
      await this.ready;
      await this.acceptance.catch(() => {});
      await this.queue.catch(() => {});
      await this.refreshing?.catch(() => {});
      await this.persistence;
      if (this.hasPendingOperations()) fail(503, 'stop_unconfirmed', '安装进程停止尚未确认，暂不能切换或重置工作区');
    })();
    return this.closing;
  }
}
