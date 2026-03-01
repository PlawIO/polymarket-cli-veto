import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Veto, type GuardResult } from 'veto-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VETO_RULES_DIR = resolve(__dirname, '../../veto/rules');

// Deterministic UTC timestamps — January 2026, EST = UTC-5
const WEEKDAY_BUSINESS = '2026-01-07T15:00:00.000Z'; // Wed 10:00 AM ET
const WEEKEND = '2026-01-10T15:00:00.000Z'; // Sat 10:00 AM ET

const TOKEN = 'test-token';

function limitBuy(opts: {
  price: number;
  size: number;
  timestamp?: string;
  orderType?: string;
}): Record<string, unknown> {
  return {
    token: TOKEN,
    side: 'buy',
    price: opts.price,
    size: opts.size,
    amount_usd: Number((opts.price * opts.size).toFixed(8)),
    ...(opts.orderType ? { orderType: opts.orderType } : {}),
    timestamp: opts.timestamp ?? WEEKDAY_BUSINESS,
  };
}

function limitSell(opts: {
  price: number;
  size: number;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    token: TOKEN,
    side: 'sell',
    price: opts.price,
    size: opts.size,
    amount_usd: Number((opts.price * opts.size).toFixed(8)),
    timestamp: opts.timestamp ?? WEEKDAY_BUSINESS,
  };
}

function ctfArgs(tool: string): Record<string, unknown> {
  const base: Record<string, unknown> = { condition: '0xabc', timestamp: WEEKDAY_BUSINESS };
  if (tool !== 'ctf_redeem') {
    base.amount = 50;
    base.amount_usd = 50;
  }
  return base;
}

describe('policy evaluation', () => {
  let veto: Veto;
  let testConfigDir: string;

  beforeAll(async () => {
    // Create a temporary config dir that uses local validation mode
    // (the real veto.config.yaml uses cloud mode which requires an API key)
    testConfigDir = mkdtempSync(join(tmpdir(), 'veto-policy-test-'));
    writeFileSync(
      join(testConfigDir, 'veto.config.yaml'),
      [
        'version: "1.0"',
        'mode: strict',
        'validation:',
        '  mode: local',
        'rules:',
        `  directory: ${VETO_RULES_DIR}`,
        '  recursive: true',
      ].join('\n'),
    );

    veto = await Veto.init({
      configDir: testConfigDir,
      logLevel: 'silent',
    });
  });

  afterAll(() => {
    rmSync(testConfigDir, { recursive: true, force: true });
  });

  function guard(profile: string, tool: string, args: Record<string, unknown>): Promise<GuardResult> {
    return veto.guard(tool, args, { sessionId: 'test', agentId: `profile/${profile}` });
  }

  // ── defaults ────────────────────────────────────────────────────────────

  describe('defaults', () => {
    it('allows small buy under $25', async () => {
      const r = await guard('defaults', 'order_create_limit', limitBuy({ price: 0.10, size: 100 }));
      expect(r.decision).toBe('allow');
    });

    it('requires approval for buy over $25', async () => {
      const r = await guard('defaults', 'order_create_limit', limitBuy({ price: 0.10, size: 300 }));
      expect(r.decision).toBe('require_approval');
    });

    it('requires approval for cancel all', async () => {
      const r = await guard('defaults', 'order_cancel_all', { timestamp: WEEKDAY_BUSINESS });
      expect(r.decision).toBe('require_approval');
    });

    it('denies CTF split', async () => {
      const r = await guard('defaults', 'ctf_split', ctfArgs('ctf_split'));
      expect(r.decision).toBe('deny');
    });
  });

  // ── agent ───────────────────────────────────────────────────────────────

  describe('agent', () => {
    it('allows small buy during business hours', async () => {
      const r = await guard('agent', 'order_create_limit', limitBuy({ price: 0.10, size: 100, timestamp: WEEKDAY_BUSINESS }));
      expect(r.decision).toBe('allow');
    });

    it('allows small buy on weekend (outside_hours only covers weekdays)', async () => {
      // agent profile's outside_hours rule only lists Mon-Fri — weekends
      // are uncovered, unlike user profile which has explicit weekend groups
      const r = await guard('agent', 'order_create_limit', limitBuy({ price: 0.10, size: 100, timestamp: WEEKEND }));
      expect(r.decision).toBe('allow');
    });

    it('requires approval for buy over $25 during business hours', async () => {
      const r = await guard('agent', 'order_create_limit', limitBuy({ price: 0.10, size: 300, timestamp: WEEKDAY_BUSINESS }));
      expect(r.decision).toBe('require_approval');
    });

    it('denies CTF split', async () => {
      const r = await guard('agent', 'ctf_split', ctfArgs('ctf_split'));
      expect(r.decision).toBe('deny');
    });
  });

  // ── user ────────────────────────────────────────────────────────────────

  describe('user', () => {
    it('allows small buy during market hours', async () => {
      const r = await guard('user', 'order_create_limit', limitBuy({ price: 0.10, size: 100 }));
      expect(r.decision).toBe('allow');
    });

    it('requires approval for buy over $100', async () => {
      const r = await guard('user', 'order_create_limit', limitBuy({ price: 0.10, size: 1500 }));
      expect(r.decision).toBe('require_approval');
    });

    it('denies buy over $500', async () => {
      const r = await guard('user', 'order_create_limit', limitBuy({ price: 0.10, size: 6000 }));
      expect(r.decision).toBe('deny');
    });

    it('denies near-resolution buy at $0.99', async () => {
      const r = await guard('user', 'order_create_limit', limitBuy({ price: 0.99, size: 10 }));
      expect(r.decision).toBe('deny');
    });

    it('requires approval for all sells', async () => {
      const r = await guard('user', 'order_create_limit', limitSell({ price: 0.55, size: 100 }));
      expect(r.decision).toBe('require_approval');
    });

    it('denies FOK order over $50', async () => {
      const r = await guard('user', 'order_create_limit', limitBuy({ price: 0.10, size: 600, orderType: 'FOK' }));
      expect(r.decision).toBe('deny');
    });

    it('requires approval for weekend trading', async () => {
      const r = await guard('user', 'order_create_limit', limitBuy({ price: 0.10, size: 100, timestamp: WEEKEND }));
      expect(r.decision).toBe('require_approval');
    });

    it('denies cancel all', async () => {
      const r = await guard('user', 'order_cancel_all', { timestamp: WEEKDAY_BUSINESS });
      expect(r.decision).toBe('deny');
    });

    it('denies CTF split', async () => {
      const r = await guard('user', 'ctf_split', ctfArgs('ctf_split'));
      expect(r.decision).toBe('deny');
    });
  });

  // ── conservative ────────────────────────────────────────────────────────

  describe('conservative', () => {
    it('requires approval for any order', async () => {
      const r = await guard('conservative', 'order_create_limit', limitBuy({ price: 0.10, size: 100 }));
      expect(r.decision).toBe('require_approval');
    });

    it('denies CTF split (regression)', async () => {
      const r = await guard('conservative', 'ctf_split', ctfArgs('ctf_split'));
      expect(r.decision).toBe('deny');
    });

    it('denies CTF merge (regression)', async () => {
      const r = await guard('conservative', 'ctf_merge', ctfArgs('ctf_merge'));
      expect(r.decision).toBe('deny');
    });

    it('denies CTF redeem (regression)', async () => {
      const r = await guard('conservative', 'ctf_redeem', ctfArgs('ctf_redeem'));
      expect(r.decision).toBe('deny');
    });
  });

  // ── cross-profile CTF regression ────────────────────────────────────────

  describe('cross-profile CTF blocking', () => {
    const CTF_TOOLS = ['ctf_split', 'ctf_merge', 'ctf_redeem'] as const;
    const PROFILES = ['defaults', 'agent', 'user', 'conservative'] as const;

    for (const profile of PROFILES) {
      for (const tool of CTF_TOOLS) {
        it(`${profile}: denies ${tool}`, async () => {
          const r = await guard(profile, tool, ctfArgs(tool));
          expect(r.decision).toBe('deny');
        });
      }
    }
  });
});
