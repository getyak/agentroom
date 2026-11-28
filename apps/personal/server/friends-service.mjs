import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APIError, digest } from './store.mjs';

const API = '/api/friends';
const DAY = 86_400_000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const clientPattern = /^[A-Za-z0-9_-]{22,80}$/;
const cookieName = 'agentroom_friends';
const actionFields = {
  register: ['name', 'clientId'], lookup: ['code'], request: ['code', 'version'],
  respond: ['code', 'version', 'decision'], invite: ['clientId'], revoke: ['inviteId'],
  preview: ['token'], join: ['token', 'version'], messages: ['code'], send: ['code', 'text', 'clientId'],
};
const failure = (status, code, message) => new APIError(status, code, message);
const invalid = () => failure(400, 'invalid_input', '请检查填写的内容');
const unavailable = () => failure(404, 'invite_unavailable', '邀请已失效，请向对方索取新链接');
const missing = () => failure(404, 'friend_not_found', '没有找到该好友码');
const forbidden = () => failure(403, 'friend_access_denied', '你无法进行这项操作');
const conflict = () => failure(409, 'friend_state_changed', '状态已变化，请刷新后重试');
const secureHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

export function friendsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('好友服务需要 HTTPS');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('好友服务地址只接受源站地址');
  return url.origin;
}

export function readFriendAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.action !== 'string' || !Object.hasOwn(actionFields, value.action)) throw invalid();
  if (Object.keys(value).some(field => field !== 'action' && !actionFields[value.action].includes(field))) throw invalid();
  return value;
}

function validString(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw invalid();
  return value.trim();
}
function peerCode(value) {
  const code = validString(value, 40).toUpperCase().replaceAll('-', '');
  if (!/^AR[0-9A-F]{12}$/.test(code)) throw invalid();
  return `AR-${code.slice(2, 6)}-${code.slice(6, 10)}-${code.slice(10)}`;
}
function receiptKey(value) {
  if (typeof value !== 'string' || !clientPattern.test(value)) throw invalid();
  return value;
}
function safeToken(value) {
  if (typeof value !== 'string' || !tokenPattern.test(value)) throw unavailable();
  return value;
}

function readAccountToken(request, cookieName) {
  const authorization = request.headers.authorization;
  if (authorization) {
    const token = authorization.startsWith('Bearer ') && authorization.slice(7);
    if (!token || !tokenPattern.test(token)) throw forbidden();
    return { token, browser: false };
  }
  const entry = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
  const token = entry?.slice(cookieName.length + 1);
  return { token: tokenPattern.test(token || '') ? token : null, browser: true };
}

async function readAction(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw invalid();
  const bytes = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 20_000) throw failure(413, 'body_too_large', '请求内容过长');
    bytes.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(bytes).toString('utf8')); } catch { throw invalid(); }
  return readFriendAction(value);
}

class FriendDirectory {
  constructor(dataDir, clock) {
    mkdirSync(dataDir, { mode: 0o700, recursive: true });
    chmodSync(dataDir, 0o700);
    const path = join(dataDir, 'friends.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.clock = clock;
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS people (
        code TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS relationships (
        low TEXT NOT NULL REFERENCES people(code), high TEXT NOT NULL REFERENCES people(code),
        sender TEXT NOT NULL, recipient TEXT NOT NULL, state TEXT NOT NULL, source TEXT NOT NULL,
        version INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(low, high)
      );
      CREATE INDEX IF NOT EXISTS relationship_high ON relationships(high, low);
      CREATE TABLE IF NOT EXISTS invites (
        owner TEXT PRIMARY KEY REFERENCES people(code), token_hash TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL, expires_at INTEGER NOT NULL, claims INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS invite_receipts (
        owner TEXT NOT NULL REFERENCES people(code), client_id TEXT NOT NULL, PRIMARY KEY(owner, client_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, low TEXT NOT NULL, high TEXT NOT NULL,
        sender TEXT NOT NULL, client_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(sender, client_id), FOREIGN KEY(low, high) REFERENCES relationships(low, high)
      );
      CREATE INDEX IF NOT EXISTS messages_pair ON messages(low, high, seq DESC);
    `);
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('browser_key', ?)").run(randomBytes(32).toString('base64url'));
    this.browserKey = this.db.prepare("SELECT value FROM settings WHERE key='browser_key'").get().value;
  }

  transaction(work, write = true) {
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  account(token) {
    return token ? this.db.prepare('SELECT code, name FROM people WHERE token_hash=?').get(digest(token)) : null;
  }

  person(code) {
    return this.db.prepare('SELECT code, name FROM people WHERE code=?').get(code) || null;
  }

  register(name, token) {
    const normalized = validString(name, 64);
    return this.transaction(() => {
      const current = this.account(token);
      if (current) return current;
      for (let attempt = 0; attempt < 4; attempt++) {
        const code = peerCode(`AR${randomBytes(6).toString('hex')}`);
        const result = this.db.prepare('INSERT INTO people VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING').run(code, normalized, digest(token));
        if (result.changes) return { code, name: normalized };
      }
      throw failure(503, 'registration_unavailable', '暂时无法创建好友名片');
    });
  }

  pair(code, peer) {
    if (code === peer) throw invalid();
    return [code, peer].sort();
  }

  row(code, peer) {
    return this.db.prepare('SELECT * FROM relationships WHERE low=? AND high=?').get(...this.pair(code, peer));
  }

  relationship(row, code, person = this.person(row.low === code ? row.high : row.low)) {
    return { person, direction: row.sender === code ? 'outgoing' : 'incoming',
      state: row.state, source: row.source, version: row.version, updatedAt: new Date(row.updated_at).toISOString() };
  }

  state(profile) {
    const rows = profile ? this.db.prepare(`
      SELECT r.*, p.code AS peer_code, p.name AS peer_name FROM relationships r
      JOIN people p ON p.code=CASE WHEN r.low=? THEN r.high ELSE r.low END
      WHERE (r.low=? OR r.high=?) ORDER BY r.updated_at DESC
    `).all(profile.code, profile.code, profile.code) : [];
    const invitation = profile && this.db.prepare('SELECT client_id, expires_at, claims FROM invites WHERE owner=? AND revoked=0 AND expires_at>?').get(profile.code, this.clock());
    return { enabled: true, profile: profile || null,
      relationships: rows.map(row => this.relationship(row, profile.code, { code: row.peer_code, name: row.peer_name })),
      invitation: invitation ? { id: invitation.client_id, expiresAt: new Date(invitation.expires_at).toISOString(), claims: invitation.claims } : null };
  }

  lookup(code, input) {
    const peer = peerCode(input);
    const person = this.person(peer);
    if (!person) throw missing();
    const row = code === peer ? null : this.row(code, peer);
    return { person, self: code === peer, relationship: row ? this.relationship(row, code, person) : null };
  }

  request(code, peer, version, source, invite) {
    if (!Number.isSafeInteger(version) || version < 0) throw invalid();
    return this.transaction(() => {
      const pair = this.pair(code, peer);
      const person = this.person(peer);
      if (!person) throw missing();
      if (invite) this.activeInvite(invite);
      const row = this.row(code, peer);
      if (row && ['accepted', 'pending'].includes(row.state)) return { relationship: this.relationship(row, code, person) };
      if (version !== (row?.version || 0)) throw conflict();
      const stamp = this.clock();
      if (row && ['declined', 'removed'].includes(row.state) && row.sender === code && stamp - row.updated_at < DAY) {
        throw failure(429, 'friend_request_cooldown', '请给对方一些时间，明天再试');
      }
      if (invite) {
        const spent = this.db.prepare('UPDATE invites SET claims=claims+1 WHERE token_hash=? AND claims<20').run(digest(invite));
        if (!spent.changes) throw unavailable();
      }
      const state = {
        low: pair[0], high: pair[1], sender: code, recipient: peer, source,
        state: 'pending', version: (row?.version || 0) + 1, updated_at: stamp,
      };
      this.db.prepare(`
        INSERT INTO relationships VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(low, high) DO UPDATE SET sender=excluded.sender, recipient=excluded.recipient,
           state='pending', source=excluded.source, version=excluded.version, updated_at=excluded.updated_at
      `).run(...pair, code, peer, source, state.version, stamp);
      return { relationship: this.relationship(state, code, person) };
    });
  }

  respond(code, input) {
    const peer = peerCode(input.code);
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw invalid();
    const decisions = { accept: 'accepted', decline: 'declined', withdraw: 'withdrawn', remove: 'removed' };
    if (typeof input.decision !== 'string' || !Object.hasOwn(decisions, input.decision)) throw invalid();
    const state = decisions[input.decision];
    return this.transaction(() => {
      const row = this.row(code, peer);
      if (!row) throw missing();
      const permitted = input.decision === 'remove' || (input.decision === 'withdraw' ? row.sender === code : row.recipient === code);
      if (!permitted) throw forbidden();
      if (row.state === state && row.version === input.version + 1) return { relationship: this.relationship(row, code) };
      const from = input.decision === 'remove' ? 'accepted' : 'pending';
      if (row.state !== from || row.version !== input.version) throw conflict();
      const stamped = { ...row, state, version: row.version + 1, updated_at: this.clock() };
      this.db.prepare('UPDATE relationships SET state=?, version=?, updated_at=? WHERE low=? AND high=?')
        .run(state, stamped.version, stamped.updated_at, row.low, row.high);
      return { relationship: this.relationship(stamped, code) };
    });
  }

  invite(code, accountToken, clientId, origin) {
    receiptKey(clientId);
    return this.transaction(() => {
      const token = createHmac('sha256', accountToken).update(`agentroom friend invite ${clientId}`).digest('base64url');
      const previous = this.db.prepare('SELECT * FROM invites WHERE owner=?').get(code);
      const expires = previous?.client_id === clientId ? previous.expires_at : this.clock() + 7 * DAY;
      if (previous?.client_id === clientId) {
        if (previous.revoked || expires <= this.clock() || previous.token_hash !== digest(token)) throw conflict();
      } else {
        const receipt = this.db.prepare('INSERT INTO invite_receipts VALUES (?, ?) ON CONFLICT DO NOTHING').run(code, clientId);
        if (!receipt.changes) throw conflict();
        this.db.prepare(`
          INSERT INTO invites (owner, token_hash, client_id, expires_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(owner) DO UPDATE SET token_hash=excluded.token_hash, client_id=excluded.client_id,
            expires_at=excluded.expires_at, claims=0, revoked=0
        `).run(code, digest(token), clientId, expires);
      }
      return { link: { id: clientId, url: `${origin}/friends#invite=${token}`, expiresAt: new Date(expires).toISOString() } };
    });
  }

  revoke(code, inviteId) {
    receiptKey(inviteId);
    return this.transaction(() => {
      const updated = this.db.prepare('UPDATE invites SET revoked=1 WHERE owner=? AND client_id=?').run(code, inviteId);
      if (!updated.changes) throw conflict();
      return this.state(this.person(code));
    });
  }

  activeInvite(token) {
    const row = this.db.prepare('SELECT * FROM invites WHERE token_hash=? AND revoked=0 AND expires_at>?').get(digest(safeToken(token)), this.clock());
    if (!row) throw unavailable();
    return row;
  }

  message(row) {
    return { id: row.id, from: row.sender, text: row.text, createdAt: new Date(row.created_at).toISOString() };
  }

  messages(code, peer) {
    return this.transaction(() => {
      const row = this.row(code, peer);
      if (row?.state !== 'accepted') throw forbidden();
      const messages = this.db.prepare('SELECT * FROM messages WHERE low=? AND high=? ORDER BY seq DESC LIMIT 100')
        .all(row.low, row.high).reverse().map(message => this.message(message));
      return { messages };
    }, false);
  }

  send(code, input) {
    const peer = peerCode(input.code), text = validString(input.text, 4000), clientId = receiptKey(input.clientId);
    return this.transaction(() => {
      const row = this.row(code, peer);
      if (row?.state !== 'accepted') throw forbidden();
      const old = this.db.prepare('SELECT * FROM messages WHERE sender=? AND client_id=?').get(code, clientId);
      if (old) {
        if (old.low !== row.low || old.high !== row.high || old.text !== text) throw conflict();
        return { message: this.message(old) };
      }
      const message = { id: randomUUID(), sender: code, text, created_at: this.clock() };
      this.db.prepare('INSERT INTO messages(id, low, high, sender, client_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(message.id, row.low, row.high, code, clientId, text, message.created_at);
      return { message: this.message(message) };
    });
  }
}

function checkRate(buckets, key, limit) {
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [k, value] of buckets) if (value.reset <= now) buckets.delete(k);
    if (buckets.size > 10_000 && !buckets.has(key)) throw failure(429, 'friends_busy', '操作频繁，请稍后再试');
  }
  const current = buckets.get(key);
  const bucket = current?.reset > now ? current : { used: 0, reset: now + 60_000 };
  if (++bucket.used > limit) throw failure(429, 'friends_busy', '操作频繁，请稍后再试');
  buckets.set(key, bucket);
}

function json(response, status, result, headers = {}) {
  response.writeHead(status, { ...secureHeaders, ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(result));
}

function staticFile(response, directory, pathname) {
  const file = pathname === '/friends' ? 'friends.html' : /^\/assets\/[A-Za-z0-9_.-]+$/.test(pathname) ? pathname.slice(1) : null;
  const mime = file && contentTypes[extname(file)];
  const path = file && join(directory, file);
  if (!mime || !existsSync(path) || !statSync(path).isFile()) return false;
  response.writeHead(200, { ...secureHeaders, 'Content-Type': mime, ...(file.startsWith('assets/') ? { 'Cache-Control': 'public, max-age=86400' } : {}) });
  const stream = createReadStream(path);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
  return true;
}

export async function openFriendsService({ dataDir, port = 0, origin: publicOrigin, staticDir, clock = Date.now, proxyIpHeader = null }) {
  if (proxyIpHeader !== null && !['x-real-ip', 'cf-connecting-ip'].includes(proxyIpHeader)) {
    throw new Error('Invalid trusted proxy IP header');
  }
  const directory = new FriendDirectory(dataDir, clock);
  const buckets = new Map();
  let origin = publicOrigin && friendsOrigin(publicOrigin);
  const server = createServer({ requestTimeout: 15000, headersTimeout: 8000 }, async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (url.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site' && request.method !== 'GET') throw forbidden();
      if (request.method === 'GET' && staticDir && staticFile(response, staticDir, url.pathname)) return;
      if (url.pathname !== API || url.search || !['GET', 'POST'].includes(request.method)) throw failure(404, 'not_found', '未找到这个页面');
      const https = origin.startsWith('https:');
      const sessionCookie = https ? `__Host-${cookieName}` : cookieName;
      const identity = readAccountToken(request, sessionCookie);
      const profile = directory.account(identity.token);
      if (request.method === 'GET') return json(response, 200, directory.state(profile));
      if (identity.browser && request.headers.origin !== origin) throw forbidden();
      const realIp = proxyIpHeader && request.headers[proxyIpHeader];
      const ip = typeof realIp === 'string' && isIP(realIp) ? realIp : request.socket.remoteAddress;
      checkRate(buckets, `ip:${ip}`, 240);
      const input = await readAction(request);
      if (input.action === 'register') {
        const clientId = receiptKey(input.clientId);
        const token = identity.browser && !profile
          ? createHmac('sha256', directory.browserKey).update(clientId).digest('base64url')
          : identity.token;
        if (!profile) checkRate(buckets, `register:${ip}`, 24);
        const account = directory.register(input.name, token);
        const cookie = `${sessionCookie}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${https ? '; Secure' : ''}`;
        return json(response, 200, directory.state(account), identity.browser ? { 'Set-Cookie': cookie } : {});
      }
      if (input.action === 'preview') {
        const invitation = directory.activeInvite(input.token);
        if (invitation.claims >= 20) throw unavailable();
        return json(response, 200, { person: directory.person(invitation.owner) });
      }
      if (!profile) throw failure(401, 'friend_profile_required', '请先创建好友名片');
      const code = profile.code;
      checkRate(buckets, `account:${code}`, 90);
      if (['request', 'join', 'lookup', 'invite'].includes(input.action)) checkRate(buckets, `contacts:${code}`, 20);
      let result;
      switch (input.action) {
        case 'lookup': result = directory.lookup(code, input.code); break;
        case 'request': result = directory.request(code, peerCode(input.code), input.version, 'code'); break;
        case 'respond': result = directory.respond(code, input); break;
        case 'invite': result = directory.invite(code, identity.token, input.clientId, origin); break;
        case 'revoke': result = directory.revoke(code, input.inviteId); break;
        case 'join': {
          const invitation = directory.activeInvite(input.token);
          result = directory.request(code, invitation.owner, input.version, 'invite', input.token);
          break;
        }
        case 'messages': result = directory.messages(code, peerCode(input.code)); break;
        case 'send': result = directory.send(code, input); break;
        default: throw invalid();
      }
      return json(response, 200, result);
    } catch (error) {
      if (!response.destroyed && !response.headersSent) json(response, error instanceof APIError ? error.status : 500,
        { error: { code: error instanceof APIError ? error.code : 'friends_unavailable', message: error instanceof APIError ? error.message : '好友服务暂时无法连接' } });
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { directory.db.close(); throw error; }
  origin ||= `http://127.0.0.1:${server.address().port}`;
  return {
    origin, port: server.address().port,
    async close() {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      directory.db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const service = await openFriendsService({
    port: Number(process.env.AGENTROOM_FRIENDS_PORT || 18753),
    origin: process.env.AGENTROOM_FRIENDS_URL,
    dataDir: process.env.AGENTROOM_FRIENDS_DATA_DIR || join(appDir, '..', '..', '.local', 'friends'),
    staticDir: process.env.AGENTROOM_FRIENDS_STATIC_DIR || join(appDir, 'dist'),
    proxyIpHeader: process.env.AGENTROOM_FRIENDS_TRUST_PROXY === '1'
      ? process.env.AGENTROOM_FRIENDS_PROXY_IP_HEADER || 'x-real-ip'
      : null,
  });
  console.log(`AgentRoom Friends listening on 127.0.0.1:${service.port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void service.close());
}
