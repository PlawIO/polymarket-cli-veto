import { describe, expect, it, vi } from 'vitest';
import { MarketContextResolver, type MarketContext } from '../src/market-context.js';

describe('MarketContextResolver', () => {
  it('reuses cached context within the ttl window', async () => {
    let now = 1_000;
    const load = vi.fn(async (): Promise<MarketContext> => ({
      token: 'token-1',
      volume: 25_000,
    }));

    const resolver = new MarketContextResolver({
      ttlMs: 5_000,
      now: () => now,
      load,
    });

    expect(await resolver.resolve('token-1')).toEqual({
      token: 'token-1',
      volume: 25_000,
    });

    now += 1_000;

    expect(await resolver.resolve('token-1')).toEqual({
      token: 'token-1',
      volume: 25_000,
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent in-flight requests per token', async () => {
    let resolveLoad: ((value: MarketContext) => void) | undefined;
    const load = vi.fn(
      () => new Promise<MarketContext>((resolve) => {
        resolveLoad = resolve;
      }),
    );

    const resolver = new MarketContextResolver({
      ttlMs: 5_000,
      now: () => 1_000,
      load,
    });

    const pendingA = resolver.resolve('token-2');
    const pendingB = resolver.resolve('token-2');

    expect(load).toHaveBeenCalledTimes(1);

    resolveLoad?.({ token: 'token-2', category: 'sports' });

    await expect(Promise.all([pendingA, pendingB])).resolves.toEqual([
      { token: 'token-2', category: 'sports' },
      { token: 'token-2', category: 'sports' },
    ]);
  });

  it('refreshes cached entries after ttl expiry', async () => {
    let now = 1_000;
    const load = vi
      .fn<() => Promise<MarketContext>>()
      .mockResolvedValueOnce({ token: 'token-3', volume: 10_000 })
      .mockResolvedValueOnce({ token: 'token-3', volume: 20_000 });

    const resolver = new MarketContextResolver({
      ttlMs: 5_000,
      now: () => now,
      load,
    });

    expect(await resolver.resolve('token-3')).toEqual({ token: 'token-3', volume: 10_000 });

    now += 6_000;

    expect(await resolver.resolve('token-3')).toEqual({ token: 'token-3', volume: 20_000 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed lookups', async () => {
    const load = vi
      .fn<() => Promise<MarketContext | null>>()
      .mockRejectedValueOnce(new Error('temporary market lookup failure'))
      .mockResolvedValueOnce({ token: 'token-4', liquidityUsd: 15_000 });

    const resolver = new MarketContextResolver({
      ttlMs: 5_000,
      now: () => 1_000,
      load,
    });

    await expect(resolver.resolve('token-4')).resolves.toBeNull();
    await expect(resolver.resolve('token-4')).resolves.toEqual({
      token: 'token-4',
      liquidityUsd: 15_000,
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
