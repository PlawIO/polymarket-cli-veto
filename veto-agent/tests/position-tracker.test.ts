import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PositionTracker, type PositionTrackerConfig } from '../src/position-tracker.js';

describe('PositionTracker', () => {
  let tempDir: string;
  let config: PositionTrackerConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pos-tracker-'));
    config = { enabled: true, dataFilePath: join(tempDir, 'data', 'positions.json') };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records a buy and creates a position', () => {
    const tracker = new PositionTracker(config);
    tracker.recordTrade({ token: 'a', side: 'buy', shares: 100, priceUsd: 0.5, amountUsd: 50 });

    const snapshot = tracker.getSnapshot();
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]!.token).toBe('a');
    expect(snapshot.positions[0]!.shares).toBe(100);
    expect(snapshot.positions[0]!.costBasisUsd).toBe(50);
  });

  it('realizes P&L on sells', () => {
    const tracker = new PositionTracker(config);
    tracker.recordTrade({ token: 'a', side: 'buy', shares: 100, priceUsd: 0.5, amountUsd: 50 });
    tracker.recordTrade({ token: 'a', side: 'sell', shares: 50, priceUsd: 0.7, amountUsd: 35 });

    const snapshot = tracker.getSnapshot();
    // Realized P&L: 50 shares * (0.7 - 0.5) = 10
    expect(snapshot.totalRealizedPnl).toBeCloseTo(10);
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]!.shares).toBe(50);
  });

  it('computes unrealized P&L with midpoint', () => {
    const tracker = new PositionTracker(config);
    tracker.recordTrade({ token: 'a', side: 'buy', shares: 100, priceUsd: 0.5, amountUsd: 50 });
    tracker.updateMidpoint('a', 0.8);

    const snapshot = tracker.getSnapshot();
    // Unrealized: 100 * (0.8 - 0.5) = 30
    expect(snapshot.totalUnrealizedPnl).toBeCloseTo(30);
    expect(snapshot.totalPnl).toBeCloseTo(30);
  });

  it('adds to position on same-side trades', () => {
    const tracker = new PositionTracker(config);
    tracker.recordTrade({ token: 'a', side: 'buy', shares: 100, priceUsd: 0.5, amountUsd: 50 });
    tracker.recordTrade({ token: 'a', side: 'buy', shares: 100, priceUsd: 0.7, amountUsd: 70 });

    const snapshot = tracker.getSnapshot();
    expect(snapshot.positions[0]!.shares).toBe(200);
    expect(snapshot.positions[0]!.costBasisUsd).toBe(120);
    expect(snapshot.positions[0]!.entryPrice).toBe(0.6);
  });

  it('closes position and flips side', () => {
    const tracker = new PositionTracker(config);
    tracker.recordTrade({ token: 'a', side: 'buy', shares: 50, priceUsd: 0.5, amountUsd: 25 });
    tracker.recordTrade({ token: 'a', side: 'sell', shares: 80, priceUsd: 0.6, amountUsd: 48 });

    const snapshot = tracker.getSnapshot();
    // Closed 50 shares at 0.6-0.5=0.1 profit each = 5 realized
    expect(snapshot.totalRealizedPnl).toBeCloseTo(5);
    // Flipped: 30 shares sell position
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]!.side).toBe('sell');
    expect(snapshot.positions[0]!.shares).toBe(30);
  });

  it('persists and loads positions', () => {
    const tracker1 = new PositionTracker(config);
    tracker1.recordTrade({ token: 'a', side: 'buy', shares: 100, priceUsd: 0.5, amountUsd: 50 });
    tracker1.updateMidpoint('a', 0.6);
    tracker1.save();

    expect(existsSync(config.dataFilePath)).toBe(true);

    const tracker2 = new PositionTracker(config);
    tracker2.load();
    const snapshot = tracker2.getSnapshot();
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]!.shares).toBe(100);
    expect(snapshot.positions[0]!.currentPrice).toBe(0.6);
  });

  it('returns undefined for missing position', () => {
    const tracker = new PositionTracker(config);
    expect(tracker.getPosition('nonexistent')).toBeUndefined();
  });
});
