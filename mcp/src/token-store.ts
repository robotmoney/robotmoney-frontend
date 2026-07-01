export interface TokenIdentity {
  memberId: string;
  memberToken: string;
}

interface AccessEntry extends TokenIdentity {
  expiresAt: number;
}

interface RefreshEntry extends TokenIdentity {
  accessToken: string;
  expiresAt: number;
}

export class TokenStore {
  readonly #access = new Map<string, AccessEntry>();
  readonly #refresh = new Map<string, RefreshEntry>();

  constructor(
    private readonly accessTtlSeconds: number,
    private readonly refreshTtlSeconds: number,
    private readonly maxFamilies = 10_000,
  ) {}

  get atCapacity(): boolean {
    return this.#refresh.size >= this.maxFamilies;
  }

  issue(identity: TokenIdentity) {
    if (this.atCapacity) return null;
    const accessToken = crypto.randomUUID();
    const refreshToken = crypto.randomUUID();
    const now = Date.now();
    this.#access.set(accessToken, {
      ...identity,
      expiresAt: now + this.accessTtlSeconds * 1000,
    });
    this.#refresh.set(refreshToken, {
      ...identity,
      accessToken,
      expiresAt: now + this.refreshTtlSeconds * 1000,
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTtlSeconds,
    };
  }

  resolveAccess(token: string): TokenIdentity | null {
    const entry = this.#access.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.revoke(token);
      return null;
    }
    return { memberId: entry.memberId, memberToken: entry.memberToken };
  }

  rotate(refreshToken: string) {
    const entry = this.#refresh.get(refreshToken);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.revoke(refreshToken);
      return null;
    }
    const identity = { memberId: entry.memberId, memberToken: entry.memberToken };
    this.revoke(refreshToken);
    return this.issue(identity);
  }

  revoke(token: string): void {
    const refresh = this.#refresh.get(token);
    if (refresh) {
      this.#refresh.delete(token);
      this.#access.delete(refresh.accessToken);
      return;
    }
    if (!this.#access.delete(token)) return;
    for (const [refreshToken, entry] of this.#refresh) {
      if (entry.accessToken === token) this.#refresh.delete(refreshToken);
    }
  }

  sweep(now = Date.now()): void {
    for (const [token, entry] of this.#access) {
      if (entry.expiresAt <= now) this.revoke(token);
    }
    for (const [token, entry] of this.#refresh) {
      if (entry.expiresAt <= now) this.revoke(token);
    }
  }
}
