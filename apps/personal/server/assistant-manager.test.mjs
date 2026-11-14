import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, access, readdir, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn as realSpawn, execFileSync } from 'node:child_process';
import { EventEmitter, on } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { AssistantManager } from './assistant-manager.mjs';
import { extractTarGzip, runChild, processGroupAlive } from './assistant-install.mjs';
const ROOT = process.env.TMPDIR || tmpdir();
const packages = {
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-code',
  pi: '@mariozechner/pi-coding-agent',
  gemini: '@google/gemini-cli',
  opencode: 'opencode-ai'
};
const registry = agents => ({
  version: '1.0.0',
  agents
});
const npmAgent = (id = 'qwen') => ({
  id,
  name: 'Qwen Code',
  description: 'Coding agent',
  version: '2.1.0',
  repository: 'https://github.com/example/qwen',
  distribution: {
    npx: {
      package: '@example/qwen@2.1.0',
      args: ['--acp']
    }
  }
});
function tarFile(path, content = 'fixture', type = '0') {
  const header = Buffer.alloc(512);
  header.write(path);
  header.write('0000755\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(Buffer.byteLength(content).toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = [...header].reduce((sum, n) => sum + n, 0).toString(8).padStart(6, '0');
  header.write(checksum + '\0 ', 148);
  return Buffer.concat([header, Buffer.from(content), Buffer.alloc((512 - Buffer.byteLength(content) % 512) % 512), Buffer.alloc(1024)]);
}
async function fixture({
  agents = [npmAgent()],
  latest = '3.0.0',
  network = true,
  spawn,
  bytes,
  url,
  installTimeoutMs
} = {}) {
  await mkdir(ROOT, {
    recursive: true
  });
  const root = await mkdtemp(join(ROOT, 'manager-'));
  const home = join(root, 'home'),
    bin = join(home, 'bin');
  await mkdir(bin, {
    recursive: true
  });
  const calls = [],
    events = new EventEmitter();
  let enabled = network;
  const fetcher = async (input, options = {}) => {
    const href = String(input);
    calls.push(href);
    if (!enabled) throw Error('offline');
    if (url && href === url) return new Response(bytes);
    if (href.includes('registry.json')) return Response.json(registry(agents));
    if (href.startsWith('https://registry.npmjs.org/')) return Response.json({
      name: decodeURIComponent(new URL(href).pathname.slice(1, -7)),
      version: latest
    });
    throw Error('unexpected URL');
  };
  const options = {
    dataDir: join(root, 'personal'),
    platform: 'darwin',
    arch: 'arm64',
    home,
    env: {
      PATH: bin,
      HOME: home
    },
    fetch: fetcher,
    ...(installTimeoutMs ? {
      installTimeoutMs
    } : {}),
    now: () => Date.parse('2026-11-14T00:00:00Z'),
    notify: () => events.emit('changed'),
    ...(spawn ? {
      spawn
    } : {})
  };
  const manager = new AssistantManager(options);
  const executable = async (id, version = '1.0.0') => {
    const p = join(bin, id);
    const output = (id + ' ' + version).replaceAll("'", "'\\''");
    await writeFile(p, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, {
      mode: 0o755
    });
    return p;
  };
  const wait = async id => {
    const iter = on(events, 'changed', {
      signal: AbortSignal.timeout(5000)
    });
    try {
      for (;;) {
        const op = (await manager.snapshot()).operations.find(item => item.id === id);
        if (op && !['queued', 'running'].includes(op.state)) return op;
        await iter.next();
      }
    } finally {
      await iter.return();
    }
  };
  return {
    root,
    home,
    bin,
    manager,
    calls,
    options,
    executable,
    wait,
    offline() {
      enabled = false;
    }
  };
}
function installer({
  fail = false,
  hold = false,
  ignoreKill = false
} = {}) {
  const stats = {
    calls: [],
    running: 0,
    maxRunning: 0,
    releases: []
  };
  const spawn = (command, args, options) => {
    if (!command.endsWith('/npm')) return realSpawn(command, args, options);
    stats.calls.push({
      command,
      args,
      options
    });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    stats.running++;
    stats.maxRunning = Math.max(stats.maxRunning, stats.running);
    let ended = false;
    const complete = async () => {
      if (ended) return;
      ended = true;
      const prefix = args[args.indexOf('--prefix') + 1],
        spec = args.at(-1),
        at = spec.lastIndexOf('@'),
        pkg = spec.slice(0, at),
        version = spec.slice(at + 1),
        name = pkg.split('/').at(-1);
      const dir = join(prefix, 'node_modules', pkg);
      await mkdir(dir, {
        recursive: true
      });
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: pkg,
        version,
        bin: {
          [name]: 'bin.mjs'
        }
      }));
      await writeFile(join(dir, 'bin.mjs'), '#!/usr/bin/env node\nconsole.log("fixture")\n', {
        mode: 0o755
      });
      stats.running--;
      child.emit('close', fail ? 1 : 0);
    };
    stats.child = child;
    child.kill = () => {
      if (ignoreKill) return false;
      if (ended) return false;
      ended = true;
      stats.running--;
      child.emit('close', null, 'SIGTERM');
      return true;
    };
    if (hold) stats.releases.push(complete);else queueMicrotask(complete);
    return child;
  };
  return {
    spawn,
    stats
  };
}
test('catalog refresh keeps native and ACP versions distinct, with no install side effects', async () => {
  const f = await fixture();
  try {
    await f.executable('codex', '1.2.3');
    const s = await f.manager.snapshot({
      refresh: true
    });
    const native = s.entries.find(x => x.id === 'codex'),
      acp = s.entries.find(x => x.id === 'acp_qwen');
    assert.equal(native.installedVersion, '1.2.3');
    assert.equal(native.latestVersion, '3.0.0');
    assert.equal(native.updateAvailable, true);
    assert.equal(acp.latestVersion, '2.1.0');
    assert.equal(acp.installed, false);
    assert.equal(acp.kind, 'acp');
    assert.equal(s.operations.length, 0);
    assert.equal(s.source.status, 'fresh');
  } finally {
    await f.manager.close();
  }
});
test('existing executable override is authoritative and snapshots never install', async () => {
  const f = await fixture();
  try {
    await f.executable('codex');
    assert.equal((await f.manager.launch('codex')).protocol, 'cli');
    assert.deepEqual(await f.manager.launch('gemini'), null);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.manager.close();
  }
  const f2 = await fixture();
  try {
    await f2.executable('codex');
    const m = new AssistantManager({
      ...f2.options,
      commands: {
        codex: join(f2.home, 'missing')
      }
    });
    assert.equal(await m.launch('codex'), null);
    await m.close();
  } finally {
    await f2.manager.close();
  }
});
test('offline refresh serves validated persisted catalog and explicit freshness', async () => {
  const f = await fixture();
  try {
    await f.manager.snapshot({
      refresh: true
    });
    await f.manager.close();
    f.offline();
    const m = new AssistantManager(f.options);
    try {
      const s = await m.snapshot({
        refresh: true
      });
      assert.equal(s.source.status, 'cached');
      assert.ok(s.source.error);
      assert.ok(s.entries.some(x => x.id === 'acp_qwen'));
    } finally {
      await m.close();
    }
  } finally {
    await f.manager.close();
  }
});
test('invalid remote entries cannot create commands, URLs or installable catalog items', async () => {
  const f = await fixture({
    agents: [npmAgent(), {
      ...npmAgent('../escape'),
      distribution: {
        npx: {
          package: 'https://evil.invalid/script',
          args: ['--x']
        }
      }
    }, {
      ...npmAgent('evil'),
      distribution: {
        npx: {
          package: '@example/qwen@2.1.0',
          args: ['x\u0000y']
        }
      }
    }]
  });
  try {
    const s = await f.manager.snapshot({
      refresh: true
    });
    assert.ok(s.entries.some(x => x.id === 'acp_qwen'));
    assert.ok(!s.entries.some(x => x.id.includes('escape') || x.id === 'acp_evil'));
    await assert.rejects(f.manager.start({
      agentId: '../escape',
      action: 'install',
      clientId: 'safe-request'
    }));
  } finally {
    await f.manager.close();
  }
});
test('explicit npm install is pinned, isolated, idempotent and preserves old launch coordinates', async () => {
  const i = installer(),
    f = await fixture({
      spawn: i.spawn
    });
  try {
    await f.executable('npm');
    await f.executable('codex', '1.0.0');
    await f.manager.snapshot({
      refresh: true
    });
    const previous = await f.manager.launch('codex');
    const op = await f.manager.start({
      agentId: 'codex',
      action: 'update',
      clientId: 'install-unique'
    });
    assert.equal((await f.manager.start({
      agentId: 'codex',
      action: 'update',
      clientId: 'install-unique'
    })).id, op.id);
    assert.equal((await f.wait(op.id)).state, 'succeeded');
    assert.equal(i.stats.calls.length, 1);
    assert.equal(i.stats.calls[0].args.at(-1), '@openai/codex@3.0.0');
    assert.equal(i.stats.calls[0].options.shell, false);
    assert.ok(i.stats.calls[0].args.includes('--prefix'));
    const current = await f.manager.launch('codex');
    assert.equal(current.version, '3.0.0');
    assert.notEqual(current.command, previous.command);
    await access(previous.command);
    assert.equal((await f.manager.snapshot()).entries.find(x => x.id === 'codex').source, 'managed');
    await assert.rejects(f.manager.start({
      agentId: 'pi',
      action: 'install',
      clientId: 'install-unique'
    }), e => e.status === 409);
  } finally {
    await f.manager.close();
  }
});
test('ACP installation resolves its own arguments without editing vendor HOME', async () => {
  const i = installer(),
    f = await fixture({
      spawn: i.spawn
    });
  try {
    await f.executable('npm');
    const keep = join(f.home, '.pi', 'agent', 'auth.json');
    await mkdir(dirname(keep), {
      recursive: true
    });
    await writeFile(keep, 'private-fixture');
    await f.manager.snapshot({
      refresh: true
    });
    const op = await f.manager.start({
      agentId: 'acp_qwen',
      action: 'install',
      clientId: 'acp-install'
    });
    assert.equal((await f.wait(op.id)).state, 'succeeded');
    const launch = await f.manager.launch('acp_qwen');
    assert.equal(launch.protocol, 'acp');
    assert.deepEqual(launch.args, ['--acp']);
    assert.equal(await readFile(keep, 'utf8'), 'private-fixture');
  } finally {
    await f.manager.close();
  }
});
test('installation failures remain visible and jobs serialize', async () => {
  const i = installer({
      fail: true
    }),
    f = await fixture({
      spawn: i.spawn
    });
  try {
    await f.executable('npm');
    await f.manager.snapshot({
      refresh: true
    });
    const a = await f.manager.start({
        agentId: 'codex',
        action: 'install',
        clientId: 'codex-request'
      }),
      b = await f.manager.start({
        agentId: 'pi',
        action: 'install',
        clientId: 'pi-request'
      });
    assert.equal((await f.wait(a.id)).state, 'failed');
    assert.equal((await f.wait(b.id)).state, 'failed');
    assert.equal(i.stats.maxRunning, 1);
    assert.equal(await f.manager.launch('codex'), null);
  } finally {
    await f.manager.close();
  }
});
test('close stops its owned installer and persists interrupted status for restart', async () => {
  const i = installer({
      hold: true
    }),
    f = await fixture({
      spawn: i.spawn
    });
  await f.executable('npm');
  await f.manager.snapshot({
    refresh: true
  });
  const op = await f.manager.start({
    agentId: 'codex',
    action: 'install',
    clientId: 'close-request'
  });
  await new Promise(resolve => {
    if (i.stats.running) return resolve();
    const check = () => {
      if (i.stats.running) {
        f.options.notify = undefined;
        resolve();
      } else setImmediate(check);
    };
    check();
  });
  await f.manager.close();
  assert.equal(i.stats.running, 0);
  const m = new AssistantManager(f.options);
  try {
    assert.equal((await m.snapshot()).operations.find(x => x.id === op.id).state, 'interrupted');
  } finally {
    await m.close();
  }
});
test('binary tar installation verifies digest and rejects traversal and links', async () => {
  for (const [path, type] of [['../escape', '0'], ['link', '2']]) {
    const bytes = gzipSync(tarFile(path, 'bad', type)),
      url = 'https://github.com/example/tool/releases/download/v2.1.0/tool.tar.gz';
    const agent = {
      ...npmAgent('binary'),
      distribution: {
        binary: {
          'darwin-aarch64': {
            archive: url,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            cmd: './tool'
          }
        }
      }
    };
    const f = await fixture({
      agents: [agent],
      bytes,
      url
    });
    try {
      await f.manager.snapshot({
        refresh: true
      });
      const op = await f.manager.start({
        agentId: 'acp_binary',
        action: 'install',
        clientId: 'binary-request'
      });
      assert.equal((await f.wait(op.id)).state, 'failed');
      assert.equal(await f.manager.launch('acp_binary'), null);
    } finally {
      await f.manager.close();
    }
  }
});
test('valid binary install produces a pinned launch and checksum mismatch never activates', async () => {
  const url = 'https://github.com/example/tool/releases/download/v2.1.0/tool.tar.gz';
  for (const good of [true, false]) {
    const bytes = gzipSync(tarFile('tool', '#!/bin/sh\nexit 0\n')),
      agent = {
        ...npmAgent('binary'),
        distribution: {
          binary: {
            'darwin-aarch64': {
              archive: url,
              sha256: good ? createHash('sha256').update(bytes).digest('hex') : '0'.repeat(64),
              cmd: './tool',
              args: ['serve']
            }
          }
        }
      };
    const f = await fixture({
      agents: [agent],
      bytes,
      url
    });
    try {
      const op = await f.manager.start({
        agentId: 'acp_binary',
        action: 'install',
        clientId: 'valid-binary'
      }).catch(async () => {
        await f.manager.snapshot({
          refresh: true
        });
        return f.manager.start({
          agentId: 'acp_binary',
          action: 'install',
          clientId: 'valid-binary'
        });
      });
      const done = await f.wait(op.id);
      assert.equal(done.state, good ? 'succeeded' : 'failed');
      const launch = await f.manager.launch('acp_binary');
      assert.equal(Boolean(launch), good);
      if (good) {
        assert.deepEqual(launch.args, ['serve']);
        assert.ok((await stat(launch.command)).mode & 0o111);
      }
    } finally {
      await f.manager.close();
    }
  }
});
test('expectedVersion prevents installing a version the user did not see', async () => {
  const i = installer(),
    f = await fixture({
      spawn: i.spawn
    });
  try {
    await f.executable('npm');
    await f.manager.snapshot({
      refresh: true
    });
    await assert.rejects(f.manager.start({
      agentId: 'codex',
      action: 'install',
      clientId: 'version-check',
      expectedVersion: '2.0.0'
    }), error => error.status === 409 && error.code === 'version_changed');
    assert.equal(i.stats.calls.length, 0);
    const op = await f.manager.start({
      agentId: 'codex',
      action: 'install',
      clientId: 'version-check',
      expectedVersion: '3.0.0'
    });
    assert.equal((await f.wait(op.id)).state, 'succeeded');
    assert.equal((await f.manager.start({
      agentId: 'codex',
      action: 'install',
      clientId: 'version-check',
      expectedVersion: '3.0.0'
    })).id, op.id);
    await assert.rejects(f.manager.start({
      agentId: 'codex',
      action: 'install',
      clientId: 'version-check',
      expectedVersion: '4.0.0'
    }), error => error.status === 409);
  } finally {
    await f.manager.close();
  }
});
test('installed ACP entries remain discoverable after removal from the upstream registry', async () => {
  const i = installer(),
    f = await fixture({
      spawn: i.spawn
    });
  try {
    await f.executable('npm');
    await f.manager.snapshot({
      refresh: true
    });
    const op = await f.manager.start({
      agentId: 'acp_qwen',
      action: 'install',
      clientId: 'orphan-install'
    });
    assert.equal((await f.wait(op.id)).state, 'succeeded');
    const before = await f.manager.launch('acp_qwen');
    await f.manager.close();
    const m = new AssistantManager({
      ...f.options,
      fetch: async input => String(input).includes('registry.json') ? Response.json(registry([])) : Response.json({
        name: decodeURIComponent(new URL(input).pathname.slice(1, -7)),
        version: '3.0.0'
      })
    });
    try {
      const snapshot = await m.snapshot({
          refresh: true
        }),
        entry = snapshot.entries.find(x => x.id === 'acp_qwen');
      assert.ok(entry);
      assert.equal(entry.installed, true);
      assert.equal(entry.name, 'Qwen Code');
      assert.equal(entry.installSupported, false);
      assert.equal((await m.launch('acp_qwen')).command, before.command);
    } finally {
      await m.close();
    }
  } finally {
    await f.manager.close();
  }
});
test('concurrent idempotent requests create only one installation job', async () => {
  const i = installer(),
    f = await fixture({
      spawn: i.spawn
    });
  try {
    await f.executable('npm');
    await f.manager.snapshot({
      refresh: true
    });
    const input = {
        agentId: 'pi',
        action: 'install',
        clientId: 'parallel-replay',
        expectedVersion: '3.0.0'
      },
      [a, b] = await Promise.all([f.manager.start(input), f.manager.start(input)]);
    assert.equal(a.id, b.id);
    assert.equal((await f.wait(a.id)).state, 'succeeded');
    assert.equal(i.stats.calls.length, 1);
  } finally {
    await f.manager.close();
  }
});
test('pending operations remain a synchronous workspace blocker until a terminal result', async () => {
  const i = installer({
      hold: true
    }),
    f = await fixture({
      spawn: i.spawn
    });
  try {
    assert.equal(f.manager.hasPendingOperations(), false);
    await f.executable('npm');
    await f.manager.snapshot({
      refresh: true
    });
    const op = await f.manager.start({
      agentId: 'pi',
      action: 'install',
      clientId: 'pending-test'
    });
    assert.equal(f.manager.hasPendingOperations(), true);
    while (!i.stats.releases.length) await new Promise(resolve => setImmediate(resolve));
    await i.stats.releases[0]();
    assert.equal((await f.wait(op.id)).state, 'succeeded');
    assert.equal(f.manager.hasPendingOperations(), false);
  } finally {
    await f.manager.close();
  }
});
test('system-installed ACP adapter can be discovered without managed installation', async () => {
  const f = await fixture({
    agents: [{
      ...npmAgent('qwen-acp'),
      distribution: {
        npx: {
          package: '@example/qwen-acp@2.1.0',
          args: ['--acp']
        }
      }
    }]
  });
  try {
    const packageRoot = join(f.home, 'lib/node_modules/@example/qwen-acp');
    await mkdir(packageRoot, {
      recursive: true
    });
    const path = join(packageRoot, 'bin.mjs');
    await writeFile(path, `#!${process.execPath}\nconsole.log('qwen-acp 2.0.0');\n`, {
      mode: 0o755
    });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@example/qwen-acp',
      version: '2.0.0',
      bin: {
        'qwen-acp': 'bin.mjs'
      }
    }));
    await symlink(path, join(f.bin, 'qwen-acp'));
    const s = await f.manager.snapshot({
        refresh: true
      }),
      entry = s.entries.find(item => item.id === 'acp_qwen-acp');
    assert.equal(entry.installed, true);
    assert.equal(entry.source, 'system');
    assert.equal(entry.path, path);
    const launch = await f.manager.launch('acp_qwen-acp');
    assert.deepEqual(launch.args, ['--acp']);
    assert.equal(launch.version, '2.0.0');
    assert.equal(s.operations.length, 0);
  } finally {
    await f.manager.close();
  }
});
test('unconfirmed installer stop stays blocking and retains its staging directory', async () => {
  const i = installer({
      hold: true,
      ignoreKill: true
    }),
    f = await fixture({
      spawn: i.spawn
    });
  const alive = setInterval(() => {}, 100);
  try {
    await f.executable('npm');
    await f.manager.snapshot({
      refresh: true
    });
    await f.manager.start({
      agentId: 'pi',
      action: 'install',
      clientId: 'unconfirmed-stop'
    });
    while (!i.stats.running) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.manager.close(), error => error.code === 'stop_unconfirmed');
    assert.equal(f.manager.hasPendingOperations(), true);
    const staging = join(f.root, 'personal', 'assistants', 'staging');
    assert.ok((await readdir(staging)).length > 0);
    i.stats.child.emit('close', null, 'SIGKILL');
    assert.equal(f.manager.hasPendingOperations(), false);
  } finally {
    clearInterval(alive);
    i.stats.child?.emit('close', null, 'SIGKILL');
    await f.manager.close().catch(() => {});
  }
});
test('partial registry failure preserves catalog freshness and backs off background retries', async () => {
  const f = await fixture();
  try {
    await f.manager.snapshot({
      refresh: true
    });
    let calls = 0;
    f.manager.fetch = async input => {
      calls++;
      if (String(input).includes('registry.json')) throw Error('offline registry');
      return Response.json({
        name: decodeURIComponent(new URL(input).pathname.slice(1, -7)),
        version: '3.1.0'
      });
    };
    const before = (await f.manager.snapshot()).source.checkedAt;
    const s = await f.manager.snapshot({
      refresh: true
    });
    assert.equal(s.source.status, 'cached');
    assert.equal(s.source.checkedAt, before);
    assert.ok(s.source.error);
    assert.ok(s.entries.some(item => item.id === 'acp_qwen'));
    const prior = calls;
    await f.manager.snapshot();
    await f.manager.snapshot();
    assert.equal(calls, prior);
  } finally {
    await f.manager.close();
  }
});
test('background:false snapshots never start metadata network refresh', async () => {
  const f = await fixture();
  try {
    await f.executable('codex', '1.0.0');
    const initial = await f.manager.snapshot({
      background: false
    });
    assert.equal(f.calls.length, 0);
    assert.equal(initial.entries.find(item => item.id === 'codex').installed, true);
    await f.manager.snapshot({
      background: false
    });
    assert.equal(f.calls.length, 0);
    await f.manager.snapshot({
      background: false,
      refresh: true
    });
    assert.ok(f.calls.length >= 6);
    assert.equal((await f.manager.snapshot({
      background: false
    })).source.status, 'fresh');
  } finally {
    await f.manager.close();
  }
});
test('USTAR permits one empty root directory header while retaining path boundaries', async () => {
  await mkdir(ROOT, {
    recursive: true
  });
  for (const rootName of ['.', './']) {
    const dir = await mkdtemp(join(ROOT, 'tar-root-')),
      rootHeader = tarFile(rootName, '', '5').subarray(0, -1024),
      content = tarFile('./tool', '#!/bin/sh\nexit 0\n');
    await extractTarGzip(gzipSync(Buffer.concat([rootHeader, content])), dir);
    assert.equal(await readFile(join(dir, 'tool'), 'utf8'), '#!/bin/sh\nexit 0\n');
  }
  for (const bytes of [tarFile('./', 'bad', '5'), tarFile('./', 'bad', '0'), Buffer.concat([tarFile('./', '', '5').subarray(0, -1024), tarFile('.', '', '5')])]) {
    const dir = await mkdtemp(join(ROOT, 'tar-reject-'));
    await assert.rejects(extractTarGzip(gzipSync(bytes), dir));
  }
});
test('failed active-manifest persistence keeps the previously selected managed version', async () => {
  const i = installer(),
    f = await fixture({
      spawn: i.spawn
    });
  try {
    await f.executable('npm');
    await f.manager.snapshot({
      refresh: true
    });
    const first = await f.manager.start({
      agentId: 'codex',
      action: 'install',
      clientId: 'first-version'
    });
    assert.equal((await f.wait(first.id)).state, 'succeeded');
    const previous = await f.manager.launch('codex');
    f.manager.fetch = async input => String(input).includes('registry.json') ? Response.json(registry([])) : Response.json({
      name: decodeURIComponent(new URL(input).pathname.slice(1, -7)),
      version: '4.0.0'
    });
    await f.manager.snapshot({
      refresh: true
    });
    const persist = f.manager.persist.bind(f.manager);
    let rejectOnce = true;
    f.manager.persist = async () => {
      if (rejectOnce && f.manager.state.active.codex?.version === '4.0.0') {
        rejectOnce = false;
        throw Object.assign(Error('disk full'), {
          code: 'ENOSPC'
        });
      }
      return persist();
    };
    const next = await f.manager.start({
      agentId: 'codex',
      action: 'update',
      clientId: 'failed-promotion',
      expectedVersion: '4.0.0'
    });
    assert.equal((await f.wait(next.id)).state, 'failed');
    const current = await f.manager.launch('codex');
    assert.equal(current.command, previous.command);
    assert.equal(current.version, '3.0.0');
    await access(previous.command);
  } finally {
    await f.manager.close();
  }
});
test('a generic code binary is never mistaken for the registry MiniMax npm package', async () => {
  const f = await fixture({
    agents: [{
      ...npmAgent('minimax-code'),
      name: 'MiniMax Code',
      distribution: {
        npx: {
          package: '@minimax-ai/code@2.1.0',
          args: ['--acp']
        }
      }
    }]
  });
  try {
    await f.executable('code', '1.134.0');
    const entry = (await f.manager.snapshot({
      refresh: true
    })).entries.find(item => item.id === 'acp_minimax-code');
    assert.equal(entry.installed, false);
    assert.equal(await f.manager.launch('acp_minimax-code'), null);
  } finally {
    await f.manager.close();
  }
});
test('prerelease updates use semantic ordering rather than hiding newer beta versions', async () => {
  for (const [installed, latest, expected] of [['1.0.0-beta.1', '1.0.0-beta.2', true], ['1.0.0-beta.9', '1.0.0-beta.10', true], ['1.0.0-beta.2', '1.0.0-beta.alpha', true], ['1.0.0-beta', '1.0.0-beta.1', true], ['1.0.0-beta.1', '1.0.0-beta', false], ['1.0.0', '1.0.0-beta.2', false]]) {
    const f = await fixture({
      latest
    });
    try {
      await f.executable('codex', installed);
      const entry = (await f.manager.snapshot({
        refresh: true
      })).entries.find(item => item.id === 'codex');
      assert.equal(entry.updateAvailable, expected, installed + ' -> ' + latest);
    } finally {
      await f.manager.close();
    }
  }
});
test('failed initial job persistence rolls acceptance back so the same request can be retried', async () => {
  const i = installer(),
    f = await fixture({
      spawn: i.spawn
    });
  try {
    await f.executable('npm');
    await f.manager.snapshot({
      refresh: true
    });
    const persist = f.manager.persist.bind(f.manager);
    let rejectOnce = true;
    f.manager.persist = async () => {
      if (rejectOnce) {
        rejectOnce = false;
        throw Object.assign(Error('disk full'), {
          code: 'ENOSPC'
        });
      }
      return persist();
    };
    const input = {
      agentId: 'pi',
      action: 'install',
      clientId: 'durable-accept',
      expectedVersion: '3.0.0'
    };
    await assert.rejects(f.manager.start(input), error => error.code === 'ENOSPC');
    assert.equal((await f.manager.snapshot({
      background: false
    })).operations.length, 0);
    const retry = await f.manager.start(input);
    assert.equal((await f.wait(retry.id)).state, 'succeeded');
    assert.equal(i.stats.calls.length, 1);
  } finally {
    await f.manager.close().catch(() => {});
  }
});
test('installer abort waits for descendants after the leader exits', async () => {
  const controller = new AbortController();
  let group, descendant;
  const childCode = 'process.on("SIGTERM",()=>{});if(process.send)process.send({ready:true});setInterval(()=>{},1000);';
  const parentCode = 'const{spawn}=require("node:child_process");process.on("SIGTERM",()=>process.exit(0));const child=spawn(process.execPath,["-e",' + JSON.stringify(childCode) + '],{stdio:["ignore","ignore","ignore","ipc"]});child.on("message",()=>console.log("ready:"+child.pid));';
  try {
    await assert.rejects(runChild(process.execPath, ['-e', parentCode], {
      signal: controller.signal,
      onChild(child) {
        if (!child) return;
        group = child.pid;
        child.stdout.on('data', chunk => {
          const match = chunk.toString().match(/ready:(\d+)/);
          if (match) {
            descendant = Number(match[1]);
            controller.abort();
          }
        });
      }
    }), error => error.code === 'install_interrupted');
    assert.ok(descendant);
    let state = '';
    try {
      state = execFileSync('/bin/ps', ['-p', String(descendant), '-o', 'stat='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch {}
    assert.ok(!state || /^[ZX]/.test(state), 'installer descendant remained live: ' + state);
  } finally {
    if (group) try {
      process.kill(-group, 'SIGKILL');
    } catch {}
  }
});
test('binary installation has an installation-level deadline even when fetch ignores abort', async () => {
  const bytes = gzipSync(tarFile('tool', '#!/bin/sh\nexit 0\n')),
    url = 'https://github.com/example/tool/releases/download/v2.1.0/tool.tar.gz',
    agent = {
      ...npmAgent('timeout-binary'),
      distribution: {
        binary: {
          'darwin-aarch64': {
            archive: url,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            cmd: './tool'
          }
        }
      }
    },
    f = await fixture({
      agents: [agent],
      bytes,
      url,
      installTimeoutMs: 50
    });
  let release, deadline;
  try {
    await f.manager.snapshot({
      refresh: true
    });
    const original = f.manager.fetch;
    f.manager.fetch = (input, options) => String(input) === url ? new Promise(resolve => {
      release = () => resolve(new Response(bytes));
    }) : original(input, options);
    const op = await f.manager.start({
      agentId: 'acp_timeout-binary',
      action: 'install',
      clientId: 'binary-timeout'
    });
    const done = await Promise.race([f.wait(op.id), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Error('installation deadline missing')), 500);
    })]);
    assert.equal(done.state, 'failed');
    assert.match(done.error, /超时/);
    assert.equal(await f.manager.launch('acp_timeout-binary'), null);
  } finally {
    clearTimeout(deadline);
    release?.();
    await f.manager.close();
  }
});
test('managed directory links cannot redirect installation writes outside the owned root', async () => {
  for (const linkName of ['staging', 'versions', 'versions/codex']) {
    const i = installer(),
      f = await fixture({
        spawn: i.spawn
      });
    try {
      await f.executable('npm');
      await f.manager.snapshot({
        refresh: true
      });
      const external = join(f.root, 'outside');
      await mkdir(external);
      const link = join(f.root, 'personal', 'assistants', linkName);
      await mkdir(dirname(link), {
        recursive: true
      });
      await symlink(external, link);
      const op = await f.manager.start({
        agentId: 'codex',
        action: 'install',
        clientId: 'linked-root'
      });
      assert.equal((await f.wait(op.id)).state, 'failed');
      assert.deepEqual(await readdir(external), []);
      assert.equal(await f.manager.launch('codex'), null);
    } finally {
      await f.manager.close();
    }
  }
});
test('background refresh and persistence failures do not become unhandled rejections', async () => {
  await mkdir(ROOT, {
    recursive: true
  });
  const dir = await mkdtemp(join(ROOT, 'background-failure-')),
    moduleURL = new URL('./assistant-manager.mjs', import.meta.url).href;
  const program = `import{AssistantManager}from${JSON.stringify(moduleURL)};let unhandled=0;process.on('unhandledRejection',()=>unhandled++);const m=new AssistantManager({dataDir:${JSON.stringify(join(dir, 'personal'))},home:${JSON.stringify(dir)},env:{PATH:''}});await m.ready;m.refresh=async()=>{throw Error('ENOSPC')};await m.snapshot();m.persist=async()=>{throw Error('ENOSPC')};m.persistBackground();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));console.log(JSON.stringify({unhandled,error:m.source.error}));await m.close().catch(()=>{});`;
  const result = await runChild(process.execPath, ['--input-type=module', '-e', program], {
    capture: true,
    timeoutMs: 5000
  });
  assert.equal(result.code, 0);
  const output = JSON.parse(result.text.trim());
  assert.equal(output.unhandled, 0);
  assert.match(output.error, /未保存/);
});
test('failed background job projection becomes a visible terminal operation', async () => {
  const f = await fixture();
  try {
    await f.executable('npm');
    await f.manager.snapshot({
      refresh: true
    });
    f.manager.install = async () => {
      throw Error('ENOSPC');
    };
    const op = await f.manager.start({
      agentId: 'pi',
      action: 'install',
      clientId: 'job-error'
    });
    assert.equal((await f.wait(op.id)).state, 'failed');
    assert.equal(f.manager.hasPendingOperations(), false);
    assert.match((await f.manager.snapshot({
      background: false
    })).source.error, /未保存/);
  } finally {
    await f.manager.close();
  }
});
test('an unavailable owned root keeps native discovery alive and never follows the link', async () => {
  await mkdir(ROOT, {
    recursive: true
  });
  const dir = await mkdtemp(join(ROOT, 'linked-owned-root-')),
    external = join(dir, 'external'),
    dataDir = join(dir, 'personal');
  await mkdir(external);
  await mkdir(dataDir);
  await symlink(external, join(dataDir, 'assistants'));
  const manager = new AssistantManager({
    dataDir,
    home: dir,
    env: {
      PATH: ''
    }
  });
  try {
    const snapshot = await manager.snapshot({
      background: false
    });
    assert.equal(snapshot.entries.length, 5);
    assert.ok(snapshot.entries.every(item => !item.installSupported));
    assert.match(snapshot.source.error, /目录/);
    assert.deepEqual(await readdir(external), []);
    await assert.rejects(manager.start({
      agentId: 'pi',
      action: 'install',
      clientId: 'blocked-storage'
    }), error => error.code === 'storage_unavailable');
  } finally {
    await manager.close();
  }
});
test('malformed persisted cache falls back without leaving partially assigned broken state', async () => {
  const f = await fixture();
  try {
    await f.manager.snapshot({
      refresh: true
    });
    await f.manager.close();
    const path = join(f.root, 'personal', 'assistants', 'state.json'),
      stored = JSON.parse(await readFile(path, 'utf8'));
    stored.active = null;
    stored.operations = [null];
    await writeFile(path, JSON.stringify(stored));
    const manager = new AssistantManager(f.options);
    try {
      const snapshot = await manager.snapshot({
        background: false
      });
      assert.equal(snapshot.entries.length, 5);
      assert.ok(snapshot.source.error);
      assert.deepEqual(snapshot.operations, []);
    } finally {
      await manager.close();
    }
  } finally {
    await f.manager.close();
  }
});
test('recovery keeps a live installer group blocking even after its recorded leader has exited', async () => {
  const f = await fixture();
  let group, manager;
  const childCode = 'process.on("SIGTERM",()=>{});if(process.send)process.send({ready:true});setInterval(()=>{},1000);',
    parentCode = 'const{spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",' + JSON.stringify(childCode) + '],{stdio:["ignore","ignore","ignore","ipc"]});child.on("message",()=>{console.log("ready:"+child.pid);process.exit(0)});';
  try {
    await f.manager.snapshot({
      refresh: true
    });
    await f.manager.close();
    const parent = realSpawn(process.execPath, ['-e', parentCode], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    group = parent.pid;
    await new Promise((resolve, reject) => {
      parent.once('error', reject);
      parent.once('close', code => code === 0 ? resolve() : reject(Error('fixture leader failed')));
    });
    assert.equal(processGroupAlive(group), true);
    const path = join(f.root, 'personal', 'assistants', 'state.json'),
      stored = JSON.parse(await readFile(path, 'utf8'));
    stored.operations = [{
      id: 'assistant-recovery',
      agentId: 'pi',
      action: 'install',
      state: 'running',
      version: '3.0.0',
      progress: 'installing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _pid: group
    }];
    await writeFile(path, JSON.stringify(stored));
    manager = new AssistantManager(f.options);
    await manager.ready;
    assert.equal(manager.hasPendingOperations(), true);
    assert.equal((await manager.snapshot({
      background: false
    })).operations[0].state, 'interrupted');
  } finally {
    if (group) try {
      process.kill(-group, 'SIGKILL');
    } catch {}
    const until = Date.now() + 3000;
    while (group && processGroupAlive(group) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    await manager?.close();
    await f.manager.close();
  }
});
test('npm installs use stable owned HOME and cache without inherited assistant credentials', async () => {
  const i = installer(),
    f = await fixture({
      spawn: i.spawn
    });
  try {
    await f.executable('npm');
    Object.assign(f.manager.env, {
      CODEX_HOME: '/private/vendor-codex-fixture',
      CLAUDE_CONFIG_DIR: '/private/vendor-claude-fixture',
      PI_CODING_AGENT_DIR: '/private/vendor-pi-fixture',
      XDG_CONFIG_HOME: '/private/vendor-xdg-fixture',
      OPENAI_API_KEY: 'synthetic-fixture',
      ANTHROPIC_API_KEY: 'synthetic-fixture',
      NODE_OPTIONS: '--require=untrusted-fixture',
      npm_config_registry: 'https://untrusted.example',
      HTTPS_PROXY: 'https://proxy.example',
      LANG: 'zh_CN.UTF-8'
    });
    await f.manager.snapshot({
      refresh: true
    });
    const op = await f.manager.start({
      agentId: 'acp_qwen',
      action: 'install',
      clientId: 'owned-env'
    });
    assert.equal((await f.wait(op.id)).state, 'succeeded');
    const env = i.stats.calls[0].options.env;
    const owned = join(f.root, 'personal', 'assistants', 'installers');
    assert.equal(env.HOME, join(owned, 'home'));
    assert.equal(env.npm_config_cache, join(owned, 'cache'));
    assert.equal(env.npm_config_userconfig, join(owned, 'npmrc'));
    assert.equal(await readFile(env.npm_config_userconfig, 'utf8'), '');
    assert.equal(env.npm_config_registry, 'https://registry.npmjs.org');
    assert.equal(env.PATH, f.bin);
    assert.equal(env.HTTPS_PROXY, 'https://proxy.example');
    assert.equal(env.LANG, 'zh_CN.UTF-8');
    for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) assert.equal(env[key], undefined, key);
    assert.equal(f.manager.env.HOME, f.home);
    assert.equal(f.manager.env.OPENAI_API_KEY, 'synthetic-fixture');
    assert.ok((await stat(env.HOME)).isDirectory());
    assert.ok((await stat(env.npm_config_cache)).isDirectory());
    assert.ok(!(await f.manager.launch('acp_qwen')).command.startsWith(env.HOME));
  } finally {
    await f.manager.close();
  }
});
test('explicit refresh cannot write through a rejected owned-root symlink', async () => {
  await mkdir(ROOT, {
    recursive: true
  });
  const dir = await mkdtemp(join(ROOT, 'root-link-refresh-')),
    external = join(dir, 'external'),
    dataDir = join(dir, 'personal');
  await mkdir(external);
  await mkdir(dataDir);
  await symlink(external, join(dataDir, 'assistants'));
  const manager = new AssistantManager({
    dataDir,
    home: dir,
    env: {
      PATH: ''
    },
    fetch: async () => Response.json({
      version: '1.0.0',
      agents: []
    })
  });
  try {
    await assert.rejects(manager.snapshot({
      refresh: true
    }), error => error.code === 'unsafe_directory');
    assert.deepEqual(await readdir(external), []);
    const snapshot = await manager.snapshot({
      background: false
    });
    assert.equal(snapshot.entries.length, 5);
    assert.ok(snapshot.entries.every(item => !item.installSupported));
  } finally {
    await manager.close().catch(() => {});
  }
});
