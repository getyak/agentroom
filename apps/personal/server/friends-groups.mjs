import { randomUUID } from 'node:crypto';
import { APIError, digest } from './store.mjs';

export const friendGroupActions = {
  'group-create': ['title', 'people', 'clientId'],
  'group-answer': ['groupId', 'decision'],
  'group-view': ['groupId'],
  'group-send': ['groupId', 'text', 'clientId', 'targetAgentId'],
  'group-agent-add': ['groupId', 'agentId', 'name'],
  'group-agent-remove': ['groupId', 'agentId'],
  'group-work': [],
  'group-claim': ['jobId', 'claim'],
  'group-finish': ['jobId', 'claim', 'text', 'failed'],
};
export const friendGroupID = /^fg_[0-9a-f-]{36}$/;
const opaque = /^[0-9a-f-]{36}$/;
const claimKey = /^[A-Za-z0-9_-]{43}$/;
const MAX_WAIT = 300_000;
const LEASE = 135_000;
const invalid = () => new APIError(400, 'invalid_group_input', '请检查群聊内容');
const forbidden = () => new APIError(403, 'group_access_denied', '你无法进行这项群聊操作');
const conflict = () => new APIError(409, 'group_state_changed', '群聊状态已变化，请刷新');
const format = time => new Date(time).toISOString();
function clean(value, limit) {
  if (typeof value !== 'string' || value.length > limit || !value.trim()) throw invalid();
  return value.trim();
}
function id(value, pattern = opaque) {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid();
  return value;
}

export class FriendGroups {
  constructor(directory) {
    this.directory = directory;
    this.db = directory.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS friend_groups (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES people(code), title TEXT NOT NULL,
        create_key TEXT NOT NULL, invitees TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(owner,create_key)
      );
      CREATE TABLE IF NOT EXISTS friend_group_members (
        group_id TEXT NOT NULL REFERENCES friend_groups(id), code TEXT NOT NULL REFERENCES people(code),
        state TEXT NOT NULL, joined_after INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(group_id,code)
      );
      CREATE INDEX IF NOT EXISTS friend_group_members_by_code ON friend_group_members(code,group_id);
      CREATE TABLE IF NOT EXISTS friend_group_agents (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES friend_groups(id), owner TEXT NOT NULL REFERENCES people(code),
        name TEXT NOT NULL, visible_after INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS friend_group_agents_by_group ON friend_group_agents(group_id,owner);
      CREATE TABLE IF NOT EXISTS friend_group_messages (
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL REFERENCES friend_groups(id),
        sender TEXT NOT NULL REFERENCES people(code), agent_id TEXT REFERENCES friend_group_agents(id),
        text TEXT NOT NULL, client_id TEXT, target_agent_id TEXT REFERENCES friend_group_agents(id),
        created_at INTEGER NOT NULL, source_seq INTEGER, UNIQUE(sender,client_id)
      );
      CREATE INDEX IF NOT EXISTS friend_group_messages_by_group ON friend_group_messages(group_id,seq);
      CREATE TABLE IF NOT EXISTS friend_group_jobs (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES friend_groups(id), agent_id TEXT NOT NULL REFERENCES friend_group_agents(id),
        trigger_id TEXT NOT NULL UNIQUE REFERENCES friend_group_messages(id), owner TEXT NOT NULL REFERENCES people(code),
        state TEXT NOT NULL, claim_hash TEXT, claimed_at INTEGER, created_at INTEGER NOT NULL,
        reply_id TEXT REFERENCES friend_group_messages(id), completion_hash TEXT, context_after INTEGER
      );
      CREATE INDEX IF NOT EXISTS friend_group_jobs_by_owner ON friend_group_jobs(owner,state,created_at);
    `);
  }

  list(code) {
    return this.db.prepare(`
      SELECT g.id,g.title,g.owner,m.state FROM friend_group_members m JOIN friend_groups g ON g.id=m.group_id
      WHERE m.code=? AND m.state IN ('invited','joined') ORDER BY g.created_at DESC,g.id DESC LIMIT 128
    `).all(code).map(group => this.summary(group, group.state));
  }

  summary(group, membership) { return { id: group.id, title: group.title, owner: group.owner, membership }; }

  member(code, groupId) {
    id(groupId, friendGroupID);
    return this.db.prepare(`
      SELECT g.id,g.title,g.owner,m.state,m.joined_after FROM friend_group_members m JOIN friend_groups g ON g.id=m.group_id
      WHERE g.id=? AND m.code=?
    `).get(groupId, code);
  }

  joined(code, groupId) {
    const group = this.member(code, groupId);
    if (group?.state !== 'joined') throw forbidden();
    return group;
  }

  latest(groupId) {
    return this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM friend_group_messages WHERE group_id=?').get(groupId).seq;
  }

  bump(groupId) {
    const members = this.db.prepare("SELECT code FROM friend_group_members WHERE group_id=? AND state='joined'").all(groupId);
    this.directory.bump(...members.map(member => member.code));
  }

  create(code, input) {
    const title = clean(input.title, 80), clientId = id(input.clientId);
    if (!Array.isArray(input.people) || input.people.length < 1 || input.people.length > 7 ||
        input.people.some(peer => typeof peer !== 'string' || !/^AR-(?:[0-9A-F]{4}-){2}[0-9A-F]{4}$/.test(peer) || peer === code)) throw invalid();
    const people = [...new Set(input.people)].sort();
    if (people.length !== input.people.length) throw invalid();
    return this.directory.transaction(() => {
      const invitees = JSON.stringify(people);
      const old = this.db.prepare('SELECT * FROM friend_groups WHERE owner=? AND create_key=?').get(code, clientId);
      if (old) {
        if (old.title !== title || old.invitees !== invitees) throw conflict();
        return { room: this.summary(old, this.member(code, old.id).state) };
      }
      if (people.some(person => this.directory.row(code, person)?.state !== 'accepted')) throw forbidden();
      if (this.db.prepare('SELECT COUNT(*) AS n FROM friend_groups WHERE owner=?').get(code).n >= 64) {
        throw new APIError(409, 'group_limit', '创建的好友群已达上限');
      }
      const group = { id: `fg_${randomUUID()}`, owner: code, title };
      this.db.prepare('INSERT INTO friend_groups VALUES (?,?,?,?,?,?)').run(group.id, code, title, clientId, invitees, this.directory.clock());
      const add = this.db.prepare('INSERT INTO friend_group_members(group_id,code,state) VALUES (?,?,?)');
      add.run(group.id, code, 'joined');
      for (const person of people) add.run(group.id, person, 'invited');
      this.directory.bump(code, ...people);
      return { room: this.summary(group, 'joined') };
    });
  }

  answer(code, input) {
    const decisions = { join: 'joined', decline: 'declined', leave: 'left' };
    if (typeof input.decision !== 'string' || !Object.hasOwn(decisions, input.decision)) throw invalid();
    const state = decisions[input.decision];
    return this.directory.transaction(() => {
      const group = this.member(code, input.groupId);
      if (!group) throw forbidden();
      if (group.state === state) return { room: this.summary(group, state) };
      if (group.state !== (state === 'left' ? 'joined' : 'invited')) throw conflict();
      if (state === 'joined' && this.directory.row(code, group.owner)?.state !== 'accepted') throw forbidden();
      this.db.prepare('UPDATE friend_group_members SET state=?,joined_after=? WHERE group_id=? AND code=?')
        .run(state, this.latest(group.id), group.id, code);
      if (state === 'left') {
        this.db.prepare('UPDATE friend_group_agents SET removed=1 WHERE group_id=? AND owner=?').run(group.id, code);
        this.db.prepare("UPDATE friend_group_jobs SET state='failed' WHERE group_id=? AND owner=? AND state IN ('queued','running')").run(group.id, code);
      }
      this.bump(group.id);
      if (state !== 'joined') this.directory.bump(code);
      return { room: this.summary(group, state) };
    });
  }

  agent(code, input, remove) {
    const agentId = id(input.agentId);
    const name = remove ? null : clean(input.name, 64);
    return this.directory.transaction(() => {
      const group = this.joined(code, input.groupId);
      const existing = this.db.prepare('SELECT * FROM friend_group_agents WHERE id=? AND group_id=?').get(agentId, group.id);
      if (existing && existing.owner !== code) throw forbidden();
      if (remove && !existing) throw forbidden();
      if (remove) {
        this.db.prepare('UPDATE friend_group_agents SET removed=1 WHERE id=?').run(agentId);
        this.db.prepare("UPDATE friend_group_jobs SET state='failed' WHERE agent_id=? AND state IN ('queued','running')").run(agentId);
      } else if (existing) {
        if (existing.removed || existing.name !== name) throw conflict();
        return { agentId };
      } else {
        if (this.db.prepare('SELECT COUNT(*) AS n FROM friend_group_agents WHERE group_id=? AND owner=? AND removed=0').get(group.id, code).n >= 4) throw conflict();
        this.db.prepare('INSERT INTO friend_group_agents VALUES (?,?,?,?,?,0)').run(agentId, group.id, code, name, this.latest(group.id));
      }
      this.bump(group.id);
      return { agentId };
    });
  }

  rowMessage(row) {
    const now = this.directory.clock();
    const expired = row.job_state === 'queued' && row.created_at + MAX_WAIT <= now ||
      row.job_state === 'running' && row.claimed_at + LEASE <= now;
    return { id: row.id, from: row.sender, name: row.author_name, text: row.text, createdAt: format(row.created_at),
      ...(row.agent_id && { agentId: row.agent_id }),
      ...(row.target_agent_id && { targetAgentId: row.target_agent_id }),
      ...(row.job_state && { jobState: expired ? 'failed' : row.job_state }) };
  }

  history(groupId, after, limit, through = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare(`
      SELECT m.*,COALESCE(a.name,p.name) AS author_name,j.state AS job_state,j.claimed_at
      FROM friend_group_messages m JOIN people p ON p.code=m.sender
      LEFT JOIN friend_group_agents a ON a.id=m.agent_id
      LEFT JOIN friend_group_jobs j ON j.trigger_id=m.id
      WHERE m.group_id=? AND m.seq>? AND (m.source_seq IS NULL OR m.source_seq>?) AND m.seq<=? ORDER BY m.seq DESC LIMIT ?
    `).all(groupId, after, after, through, limit).reverse().map(row => this.rowMessage(row));
  }

  view(code, groupId) {
    return this.directory.transaction(() => {
      const group = this.joined(code, groupId);
      const people = this.db.prepare(`
        SELECT p.code,p.name FROM friend_group_members m JOIN people p ON p.code=m.code WHERE m.group_id=? AND m.state='joined'
      `).all(group.id);
      const agents = this.db.prepare('SELECT id,name,owner FROM friend_group_agents WHERE group_id=? AND removed=0 ORDER BY name,id').all(group.id);
      return { room: this.summary(group, 'joined'), people, agents, messages: this.history(group.id, group.joined_after, 100) };
    }, false);
  }

  send(code, input) {
    const text = clean(input.text, 4000), clientId = id(input.clientId);
    const target = input.targetAgentId == null ? null : id(input.targetAgentId);
    return this.directory.transaction(() => {
      const group = this.joined(code, input.groupId);
      const old = this.db.prepare(`
        SELECT m.*, p.name AS author_name FROM friend_group_messages m JOIN people p ON p.code=m.sender
        WHERE m.sender=? AND m.client_id=?
      `).get(code, clientId);
      if (old) {
        if (old.group_id !== group.id || old.text !== text || old.target_agent_id !== target) throw conflict();
        return { message: this.rowMessage(old) };
      }
      const agent = target && this.db.prepare('SELECT * FROM friend_group_agents WHERE id=? AND group_id=? AND removed=0').get(target, group.id);
      if (target && !agent) throw conflict();
      const stamp = this.directory.clock(), messageId = randomUUID();
      if (agent && this.db.prepare(`
        SELECT COUNT(*) AS n FROM friend_group_jobs WHERE agent_id=? AND
        ((state='queued' AND created_at>?) OR (state='running' AND claimed_at>?))
      `).get(agent.id, stamp - MAX_WAIT, stamp - LEASE).n >= 3) {
        throw new APIError(409, 'group_agent_busy', '这位 Agent 有待处理消息，请稍后再试');
      }
      this.db.prepare(`
        INSERT INTO friend_group_messages(id,group_id,sender,text,client_id,target_agent_id,created_at) VALUES (?,?,?,?,?,?,?)
      `).run(messageId, group.id, code, text, clientId, target, stamp);
      if (agent) this.db.prepare(`
        INSERT INTO friend_group_jobs(id,group_id,agent_id,trigger_id,owner,state,created_at) VALUES (?,?,?,?,?,'queued',?)
      `).run(randomUUID(), group.id, agent.id, messageId, agent.owner, stamp);
      this.bump(group.id);
      return { message: this.rowMessage({ id: messageId, sender: code, author_name: this.directory.person(code).name, text, created_at: stamp, target_agent_id: target }) };
    });
  }

  work(code) {
    return { jobs: this.db.prepare(`
      SELECT id,group_id AS groupId,agent_id AS agentId FROM friend_group_jobs
      WHERE owner=? AND state='queued' AND created_at>? ORDER BY created_at,id LIMIT 20
    `).all(code, this.directory.clock() - MAX_WAIT) };
  }

  job(code, input) {
    id(input.jobId);
    id(input.claim, claimKey);
    const job = this.db.prepare('SELECT * FROM friend_group_jobs WHERE id=? AND owner=?').get(input.jobId, code);
    if (!job) throw forbidden();
    return job;
  }

  claim(code, input) {
    return this.directory.transaction(() => {
      const job = this.job(code, input);
      const group = this.joined(code, job.group_id), stamp = this.directory.clock();
      const agent = this.db.prepare('SELECT * FROM friend_group_agents WHERE id=? AND removed=0').get(job.agent_id);
      if (!agent) throw conflict();
      const hash = digest(input.claim);
      const trigger = this.db.prepare('SELECT seq,text FROM friend_group_messages WHERE id=?').get(job.trigger_id);
      let after = job.context_after;
      if (job.state === 'running') {
        if (job.claim_hash !== hash || job.claimed_at + LEASE <= stamp) throw conflict();
      } else {
        if (job.state !== 'queued' || job.created_at + MAX_WAIT <= stamp) throw conflict();
        const audience = this.db.prepare(`
          SELECT MAX(joined_after) AS floor FROM friend_group_members WHERE group_id=? AND state='joined'
        `).get(group.id).floor;
        // Every recipient of the reply must be able to see its entire source.
        // A join after the trigger can only tighten the context to the trigger itself.
        after = Math.min(trigger.seq - 1, Math.max(audience, group.joined_after, agent.visible_after));
        this.db.prepare("UPDATE friend_group_jobs SET state='running',claim_hash=?,claimed_at=?,context_after=? WHERE id=?").run(hash, stamp, after, job.id);
        this.bump(group.id);
      }
      const context = { roomTitle: group.title, agentName: agent.name, request: trigger.text,
        messages: this.history(group.id, after, 12, trigger.seq)
          .map(({ name, text }) => ({ name, text: text.slice(0, 600) })) };
      return { context };
    });
  }

  finish(code, input) {
    if (typeof input.failed !== 'boolean') throw invalid();
    const text = input.failed ? null : clean(input.text, 12000);
    const completion = digest(JSON.stringify({ text, failed: input.failed }));
    return this.directory.transaction(() => {
      const job = this.job(code, input);
      this.joined(code, job.group_id);
      if (job.claim_hash !== digest(input.claim)) throw conflict();
      if (job.state !== 'running') {
        if (job.completion_hash !== completion) throw conflict();
        return { replyId: job.reply_id, state: job.state };
      }
      if (job.claimed_at + LEASE <= this.directory.clock()) throw conflict();
      const replyId = input.failed ? null : randomUUID();
      const state = input.failed ? 'failed' : 'finished';
      if (replyId) this.db.prepare(`
        INSERT INTO friend_group_messages(id,group_id,sender,agent_id,text,created_at,source_seq) VALUES (?,?,?,?,?,?,?)
      `).run(replyId, job.group_id, code, job.agent_id, text, this.directory.clock(), job.context_after + 1);
      this.db.prepare('UPDATE friend_group_jobs SET state=?,reply_id=?,completion_hash=? WHERE id=?')
        .run(state, replyId, completion, job.id);
      this.bump(job.group_id);
      return { replyId, state };
    });
  }
}
