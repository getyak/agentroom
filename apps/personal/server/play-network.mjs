import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APIError } from './store.mjs';

/** Owns only this workspace's narrow guest tunnel; never exposes the personal listener. */
export class PlayNetwork {
  constructor(rooms, options = {}) { this.rooms = rooms; this.options = options; this.state = 'off'; this.generation = 0; }
  status() { return { state: this.state, url: this.rooms.publicOrigin || null, error: this.error || null, temporary: true }; }
  start() {
    if (this.pending) return this.pending;
    if (this.child && ['online', 'starting'].includes(this.state)) return Promise.resolve(this.status());
    this.pending = this.launch().finally(() => { this.pending = null; }); return this.pending;
  }
  async launch() {
    if (this.stopping) await this.stopping;
    const generation = this.generation;
    await this.rooms.listen(); if (generation !== this.generation) return this.status();
    this.state = 'starting'; this.error = null; this.options.notify?.();
    const origin = `http://127.0.0.1:${this.rooms.server.address().port}`;
    try {
      await new Promise((resolve, reject) => {
        let settled = false, buffer = '', candidate = null, connected = false;
        const child = (this.options.spawn || spawn)(this.options.command || join(homedir(), '.local/bin/cloudflared'), ['tunnel', '--no-autoupdate', '--url', origin, '--protocol', 'http2'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        this.child = child;
        const done = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
        const timer = setTimeout(() => done(new Error('tunnel_timeout')), this.options.timeoutMs || 30000);
        const read = chunk => {
          buffer = (buffer + chunk.toString()).slice(-16000);
          const found = buffer.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/);
          if (found) candidate = found[0];
          // A hostname precedes the working edge connection; 1033 is otherwise
          // observable even while the UI claims the invitation is available.
          const registered = buffer.lastIndexOf('Registered tunnel connection'), unregistered = Math.max(buffer.lastIndexOf('Unregistered tunnel connection'), buffer.lastIndexOf('Retrying connection'));
          if (registered >= 0 || unregistered >= 0) connected = registered > unregistered;
          if (generation !== this.generation || this.child !== child) return;
          if (!connected && this.state === 'online') { this.rooms.publicOrigin = null; this.state = 'starting'; this.options.notify?.(); }
          if (candidate && connected && this.state === 'starting') { this.rooms.publicOrigin = candidate; this.state = 'online'; this.options.notify?.(); done(); }
        };
        child.stdout.on('data', read); child.stderr.on('data', read);
        child.once('error', () => done(new Error('tunnel_unavailable')));
        child.once('exit', () => {
          if (this.child === child) { this.child = null; this.rooms.publicOrigin = null; if (this.state !== 'off') { this.state = 'failed'; this.error = '网页邀请通道断开了，房间内容已保存，可以重新开启。'; this.options.notify?.(); } }
          done(new Error('tunnel_exited'));
        });
      });
      return this.status();
    } catch {
      if (generation !== this.generation) return this.status();
      const child = this.child; this.child = null; this.rooms.publicOrigin = null;
      await this.stopChild(child); if (generation !== this.generation) return this.status();
      this.state = 'failed';
      this.error = '暂时无法开启网页邀请。请检查网络与本机 cloudflared，再重试。'; this.options.notify?.();
      throw new APIError(503, 'tunnel_unavailable', this.error);
    }
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.generation++;
    this.state = 'off'; this.error = null; this.rooms.publicOrigin = null;
    const child = this.child; this.child = null;
    this.stopping = this.stopChild(child).finally(() => { this.stopping = null; this.options.notify?.(); });
    return this.stopping;
  }
  stopChild(child) {
    return new Promise(resolve => {
      if (!child) return resolve();
      let timer;
      const done = () => { clearTimeout(timer); resolve(); };
      child.once('exit', done);
      timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 3000);
      if (!child.kill('SIGTERM')) done();
    });
  }
}
