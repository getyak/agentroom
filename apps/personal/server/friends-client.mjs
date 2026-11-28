import { randomBytes } from 'node:crypto';
import { APIError, digest } from './store.mjs';
import { friendsOrigin, readFriendAction } from './friends-service.mjs';

const notConnected = () => new APIError(503, 'friends_not_configured', '此工作区尚未配置好友服务');
const unreachable = () => new APIError(503, 'friends_unreachable', '好友服务暂时无法连接，请稍后重试');

export class FriendsClient {
  constructor(store, { origin } = {}) {
    this.store = store;
    try { this.origin = origin ? friendsOrigin(origin) : null; } catch { this.origin = null; }
    this.endpoint = this.origin && `${this.origin}/api/friends`;
  }

  credential(create = false) {
    if (!this.origin) throw notConnected();
    const id = `friend-${digest(this.origin)}`;
    let account = this.store.get('friends_identity', id);
    if (!account && create) {
      account = { id, type: 'friend-session', url: this.origin, credentialVersion: 1 };
      account.credentialRef = this.store.vault.create(randomBytes(32).toString('base64url'), account);
      this.store.put('friends_identity', account);
    }
    return account ? this.store.vault.authorization(account) : {};
  }

  async call(input) {
    const headers = this.credential(input?.action === 'register');
    let response;
    try {
      response = await fetch(this.endpoint, {
        method: input ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { ...headers, ...(input && { 'Content-Type': 'application/json', Origin: this.origin }) },
        ...(input && { body: JSON.stringify(input) }),
      });
    } catch { throw unreachable(); }
    const result = this.store.vault.redact(await response.json().catch(() => null));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw unreachable();
    if (!response.ok) throw new APIError(response.status, result.error?.code || 'friends_unreachable', result.error?.message || unreachable().message);
    return result;
  }

  async state() {
    if (!this.origin) return { enabled: false, profile: null, relationships: [], invitation: null };
    return { ...await this.call(), origin: this.origin };
  }

  act(input) { return this.call(readFriendAction(input)); }
}
