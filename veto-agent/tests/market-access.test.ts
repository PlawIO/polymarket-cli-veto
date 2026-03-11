import { describe, expect, it } from 'vitest';
import { MarketAccessControl, type MarketAccessConfig } from '../src/market-access.js';

function makeConfig(overrides: Partial<MarketAccessConfig> = {}): MarketAccessConfig {
  return {
    enabled: true,
    mode: 'blocklist',
    tokens: [],
    categories: [],
    ...overrides,
  };
}

describe('MarketAccessControl', () => {
  it('allows all tokens when disabled', () => {
    const ctrl = new MarketAccessControl(makeConfig({ enabled: false }));
    expect(ctrl.check('any-token').allowed).toBe(true);
  });

  it('blocks tokens in blocklist mode', () => {
    const ctrl = new MarketAccessControl(makeConfig({ tokens: ['bad-token'] }));

    const blocked = ctrl.check('bad-token');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('blocklisted');

    expect(ctrl.check('good-token').allowed).toBe(true);
  });

  it('only allows tokens in allowlist mode', () => {
    const ctrl = new MarketAccessControl(
      makeConfig({ mode: 'allowlist', tokens: ['allowed-1', 'allowed-2'] }),
    );

    expect(ctrl.check('allowed-1').allowed).toBe(true);
    expect(ctrl.check('allowed-2').allowed).toBe(true);

    const rejected = ctrl.check('other-token');
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toContain('not in allowlist');
  });

  it('blocks categories in blocklist mode', () => {
    const ctrl = new MarketAccessControl(makeConfig({ categories: ['politics'] }));

    const blocked = ctrl.check('token-1', { category: 'politics' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('blocklisted');

    expect(ctrl.check('token-1', { category: 'sports' }).allowed).toBe(true);
  });

  it('enforces minimum liquidity', () => {
    const ctrl = new MarketAccessControl(makeConfig({ minLiquidityUsd: 1000 }));

    const low = ctrl.check('token-1', { liquidityUsd: 500 });
    expect(low.allowed).toBe(false);
    expect(low.reason).toContain('below minimum');

    expect(ctrl.check('token-1', { liquidityUsd: 2000 }).allowed).toBe(true);
  });

  it('integrates token + category + liquidity checks', () => {
    const ctrl = new MarketAccessControl(
      makeConfig({
        mode: 'allowlist',
        tokens: ['good-token'],
        categories: ['crypto'],
        minLiquidityUsd: 500,
      }),
    );

    // Token not in allowlist
    expect(ctrl.check('bad-token', { category: 'crypto', liquidityUsd: 1000 }).allowed).toBe(false);

    // Category not in allowlist
    expect(ctrl.check('good-token', { category: 'politics', liquidityUsd: 1000 }).allowed).toBe(false);

    // Liquidity too low
    expect(ctrl.check('good-token', { category: 'crypto', liquidityUsd: 100 }).allowed).toBe(false);

    // All checks pass
    expect(ctrl.check('good-token', { category: 'crypto', liquidityUsd: 1000 }).allowed).toBe(true);
  });
});
