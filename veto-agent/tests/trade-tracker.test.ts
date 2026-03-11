import { describe, expect, it } from 'vitest';
import { TradeTracker, type TradeLimitsConfig } from '../src/trade-tracker.js';

const LIMITS: TradeLimitsConfig = {
  enabled: true,
  maxPositionSizeUsd: 500,
  dailyVolumeLimitUsd: 1000,
};

function isoNow(): string {
  return new Date().toISOString();
}

describe('TradeTracker', () => {
  it('sums daily volume for an agent', () => {
    const tracker = new TradeTracker();
    tracker.record({ timestamp: isoNow(), toolName: 'order_market', token: 'a', side: 'buy', amountUsd: 100, agentId: 'agent-1' });
    tracker.record({ timestamp: isoNow(), toolName: 'order_market', token: 'b', side: 'buy', amountUsd: 200, agentId: 'agent-1' });
    tracker.record({ timestamp: isoNow(), toolName: 'order_market', token: 'c', side: 'buy', amountUsd: 50, agentId: 'agent-2' });

    expect(tracker.dailyVolumeUsd('agent-1')).toBe(300);
    expect(tracker.dailyVolumeUsd('agent-2')).toBe(50);
  });

  it('excludes trades older than 24 hours', () => {
    const tracker = new TradeTracker();
    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    tracker.record({ timestamp: oldTimestamp, toolName: 'order_market', token: 'a', side: 'buy', amountUsd: 500, agentId: 'agent-1' });
    tracker.record({ timestamp: isoNow(), toolName: 'order_market', token: 'b', side: 'buy', amountUsd: 100, agentId: 'agent-1' });

    expect(tracker.dailyVolumeUsd('agent-1')).toBe(100);
  });

  it('nets position size for buys and sells', () => {
    const tracker = new TradeTracker();
    tracker.record({ timestamp: isoNow(), toolName: 'order_market', token: 'a', side: 'buy', amountUsd: 300, agentId: 'agent-1' });
    tracker.record({ timestamp: isoNow(), toolName: 'order_market', token: 'a', side: 'sell', amountUsd: 100, agentId: 'agent-1' });

    expect(tracker.positionSizeUsd('a', 'agent-1')).toBe(200);
  });

  it('blocks when daily volume limit exceeded', () => {
    const tracker = new TradeTracker();
    tracker.record({ timestamp: isoNow(), toolName: 'order_market', token: 'a', side: 'buy', amountUsd: 800, agentId: 'agent-1' });

    const check = tracker.checkLimits(
      { token: 'b', amountUsd: 300, agentId: 'agent-1', side: 'buy' },
      LIMITS,
    );
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Daily volume');
  });

  it('blocks when position size limit exceeded', () => {
    const tracker = new TradeTracker();
    tracker.record({ timestamp: isoNow(), toolName: 'order_market', token: 'a', side: 'buy', amountUsd: 400, agentId: 'agent-1' });

    const check = tracker.checkLimits(
      { token: 'a', amountUsd: 200, agentId: 'agent-1', side: 'buy' },
      LIMITS,
    );
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Position size');
  });

  it('allows when within all limits', () => {
    const tracker = new TradeTracker();
    tracker.record({ timestamp: isoNow(), toolName: 'order_market', token: 'a', side: 'buy', amountUsd: 100, agentId: 'agent-1' });

    const check = tracker.checkLimits(
      { token: 'a', amountUsd: 50, agentId: 'agent-1', side: 'buy' },
      LIMITS,
    );
    expect(check.allowed).toBe(true);
  });

  it('passes when limits disabled', () => {
    const tracker = new TradeTracker();
    tracker.record({ timestamp: isoNow(), toolName: 'order_market', token: 'a', side: 'buy', amountUsd: 99999, agentId: 'agent-1' });

    const check = tracker.checkLimits(
      { token: 'a', amountUsd: 99999, agentId: 'agent-1', side: 'buy' },
      { ...LIMITS, enabled: false },
    );
    expect(check.allowed).toBe(true);
  });
});
