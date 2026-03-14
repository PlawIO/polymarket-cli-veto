export interface MarketContext {
  token: string;
  spread?: number;
  volume?: number;
  end_date?: string;
  end_date_ms?: number;
  liquidityUsd?: number;
  category?: string;
}

interface CachedMarketContext {
  value: MarketContext | null;
  expiresAt: number;
}

export interface MarketContextResolverOptions {
  ttlMs: number;
  load: (token: string) => Promise<MarketContext | null>;
  now?: () => number;
}

export class MarketContextResolver {
  private readonly cache = new Map<string, CachedMarketContext>();
  private readonly inflight = new Map<string, Promise<MarketContext | null>>();
  private readonly now: () => number;

  constructor(private readonly options: MarketContextResolverOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async resolve(token: string): Promise<MarketContext | null> {
    const cached = this.cache.get(token);
    const now = this.now();

    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const existing = this.inflight.get(token);
    if (existing) {
      return existing;
    }

    const pending = this.options.load(token)
      .then((value) => {
        this.cache.set(token, {
          value,
          expiresAt: this.now() + this.options.ttlMs,
        });
        return value;
      })
      .catch(() => null)
      .finally(() => {
        this.inflight.delete(token);
      });

    this.inflight.set(token, pending);
    return pending;
  }

  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }
}
