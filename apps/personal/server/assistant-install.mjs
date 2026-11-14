import { spawn as nativeSpawn, execFileSync } from 'node:child_process';
import { access, mkdir, readFile, realpath, lstat, writeFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
export class AssistantManagerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AssistantManagerError';
    this.status = status;
    this.code = code;
  }
}
export const fail = (status, code, message) => {
  throw new AssistantManagerError(status, code, message);
};
export const MAX_METADATA_BYTES = 5 * 1024 * 1024,
  MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export function webURL(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local') || /^\[|^\d+(?:\.|$)/.test(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0') || value.includes('\\') || isAbsolute(value) || value.split('/').some(p => p === '..')) return null;
  const path = value.replace(/^\.\//, '');
  return path && path !== '.' ? path : null;
}
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Aborted'));
    signal.addEventListener('abort', abort, {
      once: true
    });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function boundedDownload(fetcher, href, {
  limit = MAX_METADATA_BYTES,
  signal
} = {}) {
  let url = webURL(href);
  if (!url) fail(400, 'invalid_download', '下载地址不受支持');
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await abortable(fetcher(url, {
      redirect: 'manual',
      signal,
      headers: {
        Accept: limit === MAX_METADATA_BYTES ? 'application/json' : 'application/octet-stream'
      }
    }), signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = webURL(new URL(response.headers.get('location') || '', url).href);
      if (!next || redirects === 4) fail(502, 'invalid_redirect', '下载地址跳转不可用');
      url = next;
      continue;
    }
    if (!response.ok) fail(502, 'download_failed', '暂时无法读取官方目录或版本');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) fail(413, 'download_too_large', '下载内容超过大小限制');
    const chunks = [];
    let bytes = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const {
            done,
            value
          } = await abortable(reader.read(), signal);
          if (done) break;
          bytes += value.length;
          if (bytes > limit) {
            await reader.cancel();
            fail(413, 'download_too_large', '下载内容超过大小限制');
          }
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
    } else {
      const b = Buffer.from(await abortable(response.arrayBuffer(), signal));
      if (b.length > limit) fail(413, 'download_too_large', '下载内容超过大小限制');
      chunks.push(b);
    }
    return Buffer.concat(chunks);
  }
  fail(502, 'download_failed', '下载失败');
}
export async function ownedExecutable(root, path) {
  const realRoot = await realpath(root),
    real = await realpath(path);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) fail(400, 'escaped_install', '安装程序指向了版本目录之外');
  if (!(await lstat(real)).isFile()) fail(400, 'invalid_executable', '安装结果没有可运行程序');
  await access(real, constants.X_OK);
  return real;
}
/** A reaped leader is not proof that its process group has finished. */
export function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
  } catch (error) {
    return error.code === 'EPERM';
  }
  if (process.platform === 'win32') return true;
  try {
    const rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat='], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return rows.split('\n').some(row => {
      const fields = row.trim().split(/\s+/);
      return Number(fields[1]) === pid && !/^[ZX]/.test(fields[2] || '');
    });
  } catch {
    return true;
  }
}
export async function runChild(command, args, {
  spawn = nativeSpawn,
  env,
  cwd,
  signal,
  timeoutMs = 300000,
  onChild,
  onProgress,
  maxBytes = 1024 * 1024,
  capture = false
} = {}) {
  if (signal?.aborted) throw signal.reason instanceof AssistantManagerError ? signal.reason : new AssistantManagerError(409, 'install_interrupted', '安装已停止');
  return new Promise((resolveResult, reject) => {
    let child,
      done = false,
      leaderClosed = false,
      stopping = false,
      total = 0,
      text = '',
      result,
      failure;
    let timer, killTimer, confirmationTimer, poll;
    const observe = value => {
      try {
        onChild?.(value);
      } catch {}
    };
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(confirmationTimer);
      clearInterval(poll);
      signal?.removeEventListener('abort', abort);
      observe(null);
      error ? reject(error) : resolveResult(value);
    };
    const groupAlive = () => Boolean(child?.pid) && processGroupAlive(child.pid);
    const maybeFinish = () => {
      if (leaderClosed && !groupAlive()) finish(failure, result);
    };
    const send = kind => {
      if (leaderClosed && !groupAlive()) return;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, kind);else child.kill(kind);
      } catch {
        try {
          if (!leaderClosed) child.kill(kind);
        } catch {}
      }
    };
    const stop = () => {
      if (stopping || done) return;
      stopping = true;
      killTimer = setTimeout(() => send('SIGKILL'), 1000);
      confirmationTimer = setTimeout(() => finish(new AssistantManagerError(503, 'stop_unconfirmed', '安装进程停止尚未确认，请保留工作区后重试')), 2500);
      poll = setInterval(maybeFinish, 50);
      send('SIGTERM');
      maybeFinish();
    };
    const abort = () => {
      failure = signal.reason instanceof AssistantManagerError ? signal.reason : new AssistantManagerError(409, 'install_interrupted', '安装已停止');
      stop();
    };
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      observe(child);
    } catch {
      finish(new AssistantManagerError(503, 'spawn_failed', '无法启动安装程序，请检查本机 Node/npm'));
      return;
    }
    const chunk = part => {
      total += part.length;
      if (total > maxBytes && !failure) {
        failure = new AssistantManagerError(413, 'output_limit', '安装程序输出超过限制');
        stop();
      }
      if (capture && text.length < 16384) text += part.toString('utf8');
      try {
        onProgress?.();
      } catch {}
    };
    child.stdout?.on('data', chunk);
    child.stderr?.on('data', chunk);
    child.once('error', () => {
      failure = new AssistantManagerError(503, 'spawn_failed', '无法启动安装程序，请检查本机 Node/npm');
      if (child.pid) stop();else finish(failure);
    });
    child.once('close', (code, signalName) => {
      leaderClosed = true;
      result = {
        code,
        signal: signalName,
        text
      };
      if (groupAlive()) {
        failure ||= new AssistantManagerError(503, 'installer_children', '安装程序留下未结束的子进程，已停止新版本安装');
        stop();
      }
      maybeFinish();
    });
    timer = setTimeout(() => {
      failure = new AssistantManagerError(504, 'install_timeout', '安装超时，请稍后重试');
      stop();
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', abort, {
      once: true
    });
    if (signal?.aborted) abort();
  });
}
export async function ownedDirectory(root, parts, {
  create = false
} = {}) {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail(400, 'unsafe_directory', '安装目录包含外部链接，未改动链接目标');
  const realRoot = await realpath(root);
  let directory = root;
  for (const part of parts) {
    if (!safeRelative(part) || part.includes('/')) fail(400, 'unsafe_directory', '安装目录无效');
    directory = join(directory, part);
    if (create) {
      try {
        await mkdir(directory, {
          mode: 0o700
        });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const info = await lstat(directory),
      physical = await realpath(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || !physical.startsWith(realRoot + sep)) fail(400, 'unsafe_directory', '安装目录包含外部链接，未改动链接目标');
  }
  return directory;
}

/** Keep ordinary package installers away from the user's vendor profiles and npm config. */
export async function installerEnvironment(root, inherited) {
  const base = await ownedDirectory(root, ['installers'], {
    create: true
  });
  const home = await ownedDirectory(root, ['installers', 'home'], {
    create: true
  });
  const cache = await ownedDirectory(root, ['installers', 'cache'], {
    create: true
  });
  const userconfig = join(base, 'npmrc');
  try {
    const info = await lstat(userconfig);
    if (info.isSymbolicLink() || !info.isFile()) fail(400, 'unsafe_directory', '安装配置文件包含外部链接，未改动链接目标');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(userconfig, '', {
    mode: 0o600,
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW
  });
  await chmod(userconfig, 0o600);
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (typeof inherited[key] === 'string') env[key] = inherited[key];
  }
  return {
    ...env,
    HOME: home,
    npm_config_cache: cache,
    npm_config_userconfig: userconfig,
    npm_config_registry: 'https://registry.npmjs.org'
  };
}

/** Require installed npm ownership; a generic executable name such as `code` is not identity. */
export async function installedNpmOwner(command, expectedPackage) {
  let directory = dirname(command);
  for (let depth = 0; depth < 10; depth++) {
    const file = join(directory, 'package.json');
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 128 * 1024) return null;
      const body = JSON.parse(await readFile(file, 'utf8'));
      if (typeof body.name === 'string') {
        if (body.name !== expectedPackage || typeof body.version !== 'string') return null;
        const bins = typeof body.bin === 'string' ? [body.bin] : Object.values(body.bin || {});
        for (const value of bins) {
          if (!safeRelative(value)) continue;
          try {
            if ((await realpath(join(directory, value))) === command) return {
              version: body.version
            };
          } catch {}
        }
        return null;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/** Parse a bounded USTAR archive rather than handing remote paths to a shell. */
export async function extractTarGzip(bytes, directory) {
  let tar;
  try {
    tar = gunzipSync(bytes, {
      maxOutputLength: 512 * 1024 * 1024
    });
  } catch {
    fail(400, 'invalid_archive', '无法解压安装包或解压大小超过限制');
  }
  const seen = new Set();
  let total = 0,
    count = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(n => n === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const checksumText = field(148, 8).trim();
    if (!/^[0-7]+$/.test(checksumText)) fail(400, 'invalid_archive', '安装包校验头无效');
    const checksum = [...header].reduce((sum, n, index) => sum + (index >= 148 && index < 156 ? 32 : n), 0);
    if (checksum !== Number.parseInt(checksumText, 8)) fail(400, 'invalid_archive', '安装包校验头无效');
    const prefix = field(345, 155),
      name = field(0, 100),
      raw = prefix ? `${prefix}/${name}` : name,
      path = safeRelative(raw.replace(/\/$/, '')),
      kind = field(156, 1) || '0';
    if (++count > 10000) fail(400, 'unsafe_archive', '安装包条目过多');
    const sizeText = field(124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) fail(400, 'invalid_archive', '安装包文件大小无效');
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0 || (total += size) > 512 * 1024 * 1024 || offset + 512 + size > tar.length) fail(400, 'invalid_archive', '安装包文件大小超限');
    // tar -C directory . commonly emits exactly one empty root-directory header.
    // It grants no path access and must not be confused with a file or a link.
    if (kind === '5' && (raw === '.' || raw === './')) {
      if (size !== 0 || seen.has('')) fail(400, 'unsafe_archive', '安装包根目录条目无效');
      seen.add('');
      offset += 512;
      continue;
    }
    if (!path || !['0', '5'].includes(kind) || seen.has(path)) fail(400, 'unsafe_archive', '安装包包含不受支持的路径、链接或条目');
    seen.add(path);
    const destination = resolve(directory, path);
    if (!destination.startsWith(resolve(directory) + sep)) fail(400, 'unsafe_archive', '安装包路径越界');
    if (kind === '5') {
      if (size !== 0) fail(400, 'invalid_archive', '安装包目录条目无效');
      await mkdir(destination, {
        recursive: true,
        mode: 0o700
      });
    } else {
      await mkdir(dirname(destination), {
        recursive: true,
        mode: 0o700
      });
      await writeFile(destination, tar.subarray(offset + 512, offset + 512 + size), {
        mode: 0o600,
        flag: 'wx'
      });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!count) fail(400, 'empty_archive', '安装包没有文件');
}
export async function installBinary(plan, directory, {
  fetch: fetcher,
  signal
} = {}) {
  const bytes = await boundedDownload(fetcher, plan.archive, {
    limit: MAX_DOWNLOAD_BYTES,
    signal
  });
  if (createHash('sha256').update(bytes).digest('hex') !== plan.sha256.toLowerCase()) fail(400, 'checksum_mismatch', '安装包校验失败，没有启用新版本');
  const cmd = join(directory, plan.cmd);
  if (/\.(?:tar\.gz|tgz)(?:\?|$)/i.test(plan.archive)) {
    await extractTarGzip(bytes, directory);
  } else {
    await mkdir(dirname(cmd), {
      recursive: true,
      mode: 0o700
    });
    await writeFile(cmd, bytes, {
      mode: 0o600,
      flag: 'wx'
    });
  }
  await chmod(cmd, 0o755);
  return ownedExecutable(directory, cmd);
}
export async function npmExecutable(directory, plan) {
  const pkgDir = join(directory, 'node_modules', plan.package),
    body = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
  if (body.name !== plan.package || body.version !== plan.version) fail(400, 'package_mismatch', '安装结果与选定版本不同，没有启用');
  const bins = typeof body.bin === 'string' ? {
    [plan.bin || plan.package.split('/').at(-1)]: body.bin
  } : body.bin;
  if (!bins || typeof bins !== 'object') fail(400, 'missing_binary', '安装包未提供可运行助手');
  const relativeBin = bins[plan.bin] || Object.values(bins)[0];
  if (!safeRelative(relativeBin)) fail(400, 'invalid_binary', '安装包可执行路径无效');
  const command = join(pkgDir, relativeBin);
  await chmod(command, 0o755);
  return ownedExecutable(directory, command);
}
