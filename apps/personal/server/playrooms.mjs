import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, extname, sep } from 'node:path';
import { APIError, digest, id } from './store.mjs';

const fail = (status, code, message) => { throw new APIError(status, code, message); };
const text = (value, max, label, empty = false) => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(400, 'invalid_input', `请填写${label}（最多 ${max} 字）`);
  return value.trim();
};
const fields = (body, allowed) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) fail(400, 'invalid_input', '这次操作包含不支持的内容');
};
const integer = (value, fallback, max) => { const n = value ?? fallback; if (!Number.isInteger(n) || n < 1 || n > max) fail(400, 'invalid_input', '房间人数、期限或轮数超出范围'); return n; };
const cookieName = room => `ar_play_${room.replaceAll('-', '')}`;
const choices = ['山间走走', '海边放空', '城市漫游'];
const tasks = { twin: ['打个招呼', '交换一个新点子', '留下一句想说的话'], travel: ['一起选个方向', '补充预算和忌口', '确定时间与分工'], project: ['定下我们要做什么', '完成第一份草稿', '一起看成品'] };

export class Playrooms {
  constructor(store, options = {}) {
    this.store = store; this.options = options; this.clock = options.now || Date.now; this.running = new Map(); this.rate = new Map();
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
    for (const job of store.list('play_job')) if (['running', 'queued', 'stopping'].includes(job.status)) store.put('play_job', { ...job, status: job.status === 'queued' ? 'failed' : 'unknown', error: '服务曾中断，这次请求没有自动重发。', finishedAt: this.stamp() });
  }
  stamp() { return new Date(this.clock()).toISOString(); }
  active(room) {
    if (this.closed || this.suspended) fail(503, 'host_unavailable', '主人暂时离线，稍后再回来看看');
    if (room.closedAt || Date.parse(room.expiresAt) <= this.clock()) fail(410, 'room_closed', '这次邀请已结束，请主人重新邀请');
  }
  create(body, contact) {
    fields(body, ['clientId', 'template', 'title', 'brief', 'persona', 'hostName', 'maxGuests', 'maxTurns', 'ttlHours', 'contactId']);
    if (!Object.hasOwn(tasks, body.template)) fail(400, 'invalid_input', '请选择一种玩法');
    if (contact?.kind !== 'agent' || contact.binding?.type !== 'local' || !['codex', 'pi'].includes(contact.binding.localAgentId)) fail(400, 'unsupported_agent', '请选择本机 Codex 或 Pi，个人服务暂不提供访客执行');
    if (this.store.list('play_room').filter(r => !r.closedAt && Date.parse(r.expiresAt) > this.clock()).length >= 30) fail(429, 'room_limit', '先结束一个不再使用的房间，再开启新房间');
    const title = text(body.title, 80, '房间名称'), brief = text(body.brief, 6000, '共同背景'), persona = text(body.persona, 1500, '分身说明');
    const hostName = text(body.hostName || this.store.get('contact', 'self')?.name || '主人', 40, '主人昵称');
    const maxGuests = integer(body.maxGuests, 5, 10), maxTurns = integer(body.maxTurns, 30, 30), ttlHours = integer(body.ttlHours, 24, 72);
    const room = this.store.idempotent('play:create', body.clientId, body, () => {
      const roomId = id('pr'), token = randomBytes(32).toString('base64url');
      const credential = { id: roomId, type: 'play-invite', url: `https://agentroom.invalid/${roomId}`, credentialVersion: 1 };
      credential.credentialRef = this.store.vault.create(token, credential);
      const agentName = body.template === 'twin' ? `${hostName}的分身` : body.template === 'travel' ? `${hostName}的旅行搭子` : '共创搭子';
      return this.store.put('play_room', { id: roomId, template: body.template, title, brief, persona, hostName, agentName,
        backend: contact.binding.localAgentId, configuration: contact.configuration || {}, executionSnapshot: contact.executionSnapshot, inviteHash: digest(token), credential,
        maxGuests, maxTurns, turns: 0, createdAt: this.stamp(), expiresAt: new Date(this.clock() + ttlHours * 3600_000).toISOString(), version: 1,
        participants: [{ id: 'self', name: hostName, isOwner: true, joinedAt: this.stamp() }], messages: [],
        board: { choices: body.template === 'travel' ? choices.map((label, i) => ({ id: `choice_${i}`, label, votes: [] })) : [], tasks: tasks[body.template].map((label, i) => ({ id: `task_${i}`, label, done: false })), notes: '', notesVersion: 1 } });
    });
    this.changed(); return this.owner(room.id);
  }
  changed() { this.options.notify?.({ kind: 'playrooms' }); }
  list() { return this.store.list('play_room').map(r => ({ id: r.id, template: r.template, title: r.title, expiresAt: r.expiresAt, closed: Boolean(r.closedAt) || Date.parse(r.expiresAt) <= this.clock(), participantCount: r.participants.filter(p => !p.removedAt).length })); }
  invitation(roomId) {
    const room = this.store.require('play_room', roomId); this.active(room);
    const token = this.store.vault.authorization(room.credential).Authorization.slice(7);
    return { roomId, token, localUrl: `http://127.0.0.1:${this.server.address()?.port}/g/${room.id}#${token}`, url: this.publicOrigin ? `${this.publicOrigin}/g/${room.id}#${token}` : null };
  }
  project(room, actorId) {
    const participants = room.participants.filter(p => !p.removedAt).map(({ id, name, isOwner }) => ({ id, name, isOwner: Boolean(isOwner) }));
    return { id: room.id, template: room.template, title: room.title, brief: room.brief, agentName: room.agentName, hostName: room.hostName,
      expiresAt: room.expiresAt, closed: Boolean(room.closedAt) || Date.parse(room.expiresAt) <= this.clock(), version: room.version,
      participants, me: participants.find(p => p.id === actorId), messages: room.messages, board: room.board,
      remainingTurns: Math.max(0, room.maxTurns - room.turns),
      jobs: this.store.list('play_job').filter(j => j.roomId === room.id).map(j => ({ id: j.id, actorId: j.actorId, status: j.status, error: j.error })) };
  }
  owner(roomId) { return this.project(this.store.require('play_room', roomId), 'self'); }
  byInvite(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(404, 'invitation_missing', '没有找到这份邀请，请检查链接是否完整');
    const room = this.store.list('play_room').find(r => r.inviteHash === digest(token));
    if (!room) fail(404, 'invitation_missing', '没有找到这份邀请，请主人重新发一次');
    this.active(room); return room;
  }
  join(body) {
    fields(body, ['invite', 'nickname', 'clientId']);
    const room = this.byInvite(body.invite), name = text(body.nickname, 32, '你的昵称');
    const accepted = this.store.idempotent(`play:join:${room.id}`, body.clientId, { nickname: name }, () => {
      const current = this.store.require('play_room', room.id); this.active(current);
      if (current.participants.filter(p => !p.isOwner && !p.removedAt).length >= current.maxGuests) fail(429, 'guest_limit', '朋友们坐满了，请主人增加名额或移除离开的访客');
      const participant = { id: id('guest'), name, joinedAt: this.stamp() };
      current.participants.push(participant); current.version++; this.store.put('play_room', current);
      return { actorId: participant.id };
    });
    const current = this.store.require('play_room', room.id);
    if (!current.participants.some(p => p.id === accepted.actorId && !p.removedAt)) fail(401, 'guest_removed', '你已离开这个房间，请主人重新邀请');
    const secret = randomBytes(32).toString('base64url');
    this.store.put('play_session', { id: digest(`${room.id}:${body.clientId}`), hash: digest(secret), roomId: room.id, actorId: accepted.actorId, expiresAt: room.expiresAt });
    this.changed(); return { secret, room: this.project(current, accepted.actorId) };
  }
  authenticate(roomId, cookie = '') {
    const room = this.store.require('play_room', roomId); this.active(room);
    const secret = cookie.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName(roomId)}=`))?.split('=')[1];
    const session = secret && this.store.list('play_session').find(s => s.roomId === roomId && s.hash === digest(secret));
    if (!session || Date.parse(session.expiresAt) <= this.clock() || !room.participants.some(p => p.id === session.actorId && !p.removedAt)) fail(401, 'guest_session_missing', '请从邀请链接进入，再告诉大家你的昵称');
    return session.actorId;
  }
  action(roomId, actorId, body) {
    const room = this.store.require('play_room', roomId);
    const acknowledging = actorId === 'self' && body?.type === 'acknowledge';
    if (!acknowledging) this.active(room);
    const actor = room.participants.find(p => p.id === actorId && !p.removedAt);
    if (!actor) fail(401, 'guest_removed', '你已经离开这个房间');
    const allowed = { message: ['text'], vote: ['choiceId'], task: ['taskId', 'done'], notes: ['text', 'version'], close: [], remove: ['participantId'], acknowledge: ['jobId', 'confirmedStopped'] };
    if (!Object.hasOwn(allowed, body?.type)) fail(400, 'invalid_input', '不支持这个房间操作');
    if (['close', 'remove', 'acknowledge'].includes(body.type) && actorId !== 'self') fail(403, 'owner_required', '只有主人可以管理邀请和访客');
    fields(body, ['type', 'clientId', ...allowed[body.type]]);
    this.store.idempotent(`play:action:${roomId}:${actorId}`, body.clientId, body, () => {
      const current = this.store.require('play_room', roomId); if (!acknowledging) this.active(current);
      if (body.type === 'message') {
        const message = text(body.text, 4000, '消息');
        this.store.assertExecutorReady(current.backend);
        const jobs = this.store.list('play_job');
        if (jobs.some(j => j.backend === current.backend && j.status === 'unknown')) fail(409, 'execution_unknown', '原执行还在核查，主人处理后才能继续提问');
        if (jobs.some(j => j.roomId === roomId && j.actorId === actorId && ['queued', 'running'].includes(j.status))) fail(409, 'reply_pending', '等这条回复完成，再接着聊');
        if (current.turns >= current.maxTurns || current.messages.length >= 120) fail(429, 'turn_limit', '这次房间的讨论轮数已用完，可以继续整理计划或请主人新开一间');
        if (jobs.filter(j => ['queued', 'running'].includes(j.status)).length >= 20) fail(429, 'queue_full', '主人正在处理其他问题，请稍后再试');
        current.messages.push({ id: id('pm'), actorId, name: actor.name, role: 'user', text: message, createdAt: this.stamp() }); current.turns++;
        this.store.put('play_job', { id: id('pj'), roomId, actorId, backend: current.backend, configuration: current.configuration, executionSnapshot: current.executionSnapshot, status: 'queued', createdAt: this.stamp(),
          context: { title: current.title, brief: current.brief, persona: current.persona, agentName: current.agentName, messages: structuredClone(current.messages.slice(-24)), board: structuredClone(current.board) } });
      } else if (body.type === 'vote') {
        if (!current.board.choices.some(c => c.id === body.choiceId)) fail(400, 'invalid_choice', '请选择一个已有的旅行方向');
        for (const choice of current.board.choices) choice.votes = choice.votes.filter(id => id !== actorId);
        current.board.choices.find(c => c.id === body.choiceId).votes.push(actorId);
      } else if (body.type === 'task') {
        const task = current.board.tasks.find(t => t.id === body.taskId);
        if (!task || typeof body.done !== 'boolean') fail(400, 'invalid_task', '请选择现有清单项目');
        Object.assign(task, { done: body.done, updatedBy: actorId });
      } else if (body.type === 'notes') {
        if (body.version !== current.board.notesVersion) fail(409, 'notes_conflict', '朋友刚更新了便笺。你的草稿还在，请先看最新内容再保存');
        current.board.notes = text(body.text, 12000, '共同便笺', true); current.board.notesVersion++;
      } else if (body.type === 'close') {
        current.closedAt = this.stamp(); this.cancel(roomId);
      } else if (body.type === 'remove') {
        const participant = current.participants.find(p => p.id === body.participantId && !p.isOwner && !p.removedAt);
        if (!participant) fail(400, 'invalid_guest', '请选择仍在房间里的访客');
        participant.removedAt = this.stamp(); this.cancel(roomId, participant.id);
        // Anonymous display names are not durable identities. Retire the old
        // invitation as well so it cannot immediately mint a replacement actor.
        const token = randomBytes(32).toString('base64url');
        current.credential = { ...current.credential, credentialVersion: current.credential.credentialVersion + 1 };
        current.credential.credentialRef = this.store.vault.create(token, current.credential); current.inviteHash = digest(token);
      } else if (body.type === 'acknowledge') {
        const job = this.store.require('play_job', body.jobId);
        if (job.roomId !== roomId || job.status !== 'unknown' || body.confirmedStopped !== true) fail(409, 'review_required', '请先核查原执行确实已经结束');
        this.store.put('play_job', { ...job, status: 'failed', error: '主人已核查原执行结束，没有重发。' });
      }
      current.version++; this.store.put('play_room', current); return { accepted: true };
    });
    this.changed(); this.kick(); return this.project(this.store.require('play_room', roomId), actorId);
  }
  cancel(roomId, actorId) {
    for (const job of this.store.list('play_job')) if (job.roomId === roomId && (!actorId || job.actorId === actorId) && ['queued', 'running'].includes(job.status)) {
      this.store.put('play_job', { ...job, status: job.status === 'running' ? 'stopping' : 'cancelled', finishedAt: this.stamp() }); this.running.get(job.id)?.abort();
    }
  }
  kick() {
    if (this.pumping || this.closed || this.suspended || !this.options.execute) return;
    this.pumping = this.pump().finally(() => { this.pumping = null; });
  }
  async pump() {
    while (!this.closed && !this.suspended) {
      const jobs = this.store.list('play_job');
      const job = jobs.reverse().find(j => { if (j.status !== 'queued') return false; try { this.store.assertExecutorReady(j.backend); return true; } catch { return false; } }); if (!job) return;
      const controller = new AbortController(); this.running.set(job.id, controller);
      try {
        const room = this.store.require('play_room', job.roomId); this.active(room);
        this.store.put('play_job', { ...job, status: 'running' }); this.changed();
        const result = await this.options.execute(structuredClone(job.context), controller.signal, job);
        const current = this.store.require('play_room', job.roomId); this.active(current);
        if (controller.signal.aborted || this.store.require('play_job', job.id).status !== 'running' || !current.participants.some(p => p.id === job.actorId && !p.removedAt)) { if (this.store.require('play_job', job.id).status === 'stopping') this.store.put('play_job', { ...job, status: 'cancelled', finishedAt: this.stamp() }); continue; }
        const reply = text(typeof result === 'string' ? result : result?.markdown, 12000, '助手回复');
        current.messages.push({ id: id('pm'), actorId: 'agent', role: 'assistant', name: current.agentName, text: this.store.vault.redactString(reply), createdAt: this.stamp() }); current.version++;
        this.store.put('play_room', current); this.store.put('play_job', { ...job, status: 'completed', finishedAt: this.stamp() });
      } catch (error) {
        const status = this.store.require('play_job', job.id).status;
        if (error.code === 'stop_unconfirmed' || ['running', 'queued', 'stopping'].includes(status)) this.store.put('play_job', { ...job, status: error.code === 'stop_unconfirmed' ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed', error: error.code === 'stop_unconfirmed' ? '原执行的停止还未确认，请主人核查后继续。' : '这次没有收到可用回复。内容已保存，稍后可以再问。', finishedAt: this.stamp() });
      } finally { this.running.delete(job.id); this.changed(); }
    }
  }
  async listen() {
    if (this.server.listening) return this.server.address();
    if (this.closed) fail(503, 'host_unavailable', '房间服务已停止');
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.options.port ?? 0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); }); });
    return this.server.address();
  }
  async body(request) {
    if (request.headers['content-type'] !== 'application/json') fail(415, 'json_required', '需要 JSON 请求');
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 80000) fail(413, 'input_limit', '内容太长，请分成几条'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_input', '没有读懂这次操作，请重试'); }
  }
  async handle(request, response) {
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const local = `http://127.0.0.1:${this.server.address()?.port}`, hosts = new Set([new URL(local).host, `localhost:${this.server.address()?.port}`, ...(this.publicOrigin ? [new URL(this.publicOrigin).host] : [])]);
      if (!hosts.has(request.headers.host)) fail(403, 'invalid_host', '房间地址不匹配');
      if (request.headers.origin && ![local, `http://localhost:${this.server.address()?.port}`, this.publicOrigin].includes(request.headers.origin)) fail(403, 'invalid_origin', '请在房间自己的网页中参与');
      if (request.headers['sec-fetch-site'] === 'cross-site' && request.method !== 'GET') fail(403, 'invalid_origin', '请打开邀请页面后参与');
      const path = new URL(request.url, local).pathname; let match;
      const scoped = path.match(/^\/g-api\/(pr_[A-Za-z0-9_-]+)(?:\/actions)?$/);
      const rateActor = scoped ? `${scoped[1]}:${this.authenticate(scoped[1], request.headers.cookie)}` : `entry:${request.socket.remoteAddress}`;
      const bucket = Math.floor(this.clock() / 60000), rateKey = `${rateActor}:${bucket}`;
      for (const key of this.rate.keys()) if (!key.endsWith(`:${bucket}`)) this.rate.delete(key);
      const count = (this.rate.get(rateKey) || 0) + 1; this.rate.set(rateKey, count);
      if (count > 600) fail(429, 'rate_limit', '大家太热情了，稍等片刻再试');
      if (request.method === 'POST' && path === '/g-api/preview') {
        const body = await this.body(request); fields(body, ['invite']); const room = this.byInvite(body.invite);
        return json(200, { id: room.id, template: room.template, title: room.title, brief: room.brief, hostName: room.hostName, agentName: room.agentName, expiresAt: room.expiresAt, participantCount: room.participants.filter(p => !p.removedAt).length });
      }
      if (request.method === 'POST' && path === '/g-api/join') {
        const result = this.join(await this.body(request));
        const secure = this.publicOrigin && (request.headers.host === new URL(this.publicOrigin).host || request.headers.origin === this.publicOrigin);
        response.setHeader('Set-Cookie', `${cookieName(result.room.id)}=${result.secret}; Path=/g-api; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((Date.parse(result.room.expiresAt) - this.clock()) / 1000))}${secure ? '; Secure' : ''}`);
        return json(201, result.room);
      }
      if ((match = path.match(/^\/g-api\/(pr_[A-Za-z0-9_-]+)(\/actions)?$/))) {
        const actor = this.authenticate(match[1], request.headers.cookie);
        if (request.method === 'GET' && !match[2]) return json(200, this.project(this.store.require('play_room', match[1]), actor));
        if (request.method === 'POST' && match[2]) return json(200, this.action(match[1], actor, await this.body(request)));
      }
      if (request.method === 'GET' && (path === '/' || /^\/g\/pr_[A-Za-z0-9_-]+$/.test(path) || /^\/assets\/[A-Za-z0-9_.-]+$/.test(path))) {
        if (!this.options.staticDir) fail(404, 'web_unavailable', '网页还没准备好，请主人完成构建');
        const root = await realpath(this.options.staticDir);
        let target;
        if (path.startsWith('/assets/')) target = join(root, path);
        else {
          for (const candidate of ['guest.html', 'guest/index.html']) { try { target = await realpath(join(root, candidate)); break; } catch {} }
        }
        const full = target && await realpath(target);
        if (!full || !full.startsWith(root + sep)) fail(404, 'not_found', '没有这份网页');
        let bytes = await readFile(full);
        const extension = extname(full), types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
        if (!types[extension]) fail(404, 'not_found', '没有这份网页');
        if (extension === '.html') bytes = Buffer.from(bytes.toString().replace(/(?:\.\.\/|\.\/)+assets\//g, '/assets/'));
        response.writeHead(200, { 'Content-Type': types[extension] }); response.end(bytes); return;
      }
      fail(404, 'not_found', '这里仅提供受邀房间');
    } catch (error) { if (!response.headersSent) json(error.status || 500, { error: { code: error.code || 'room_unavailable', message: error.status ? error.message : '房间暂时无法连接，请稍后重试' } }); else response.end(); }
  }
  async close() {
    this.closed = true; for (const controller of this.running.values()) controller.abort();
    this.server.closeIdleConnections();
    await Promise.all([this.pumping, this.server.listening ? new Promise(r => this.server.close(r)) : null]);
  }
}
