import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, type CircuitBreakerConfig } from '../src/circuit-breaker.js';

function makeConfig(overrides: Partial<CircuitBreakerConfig> = {}): CircuitBreakerConfig {
  return {
    enabled: true,
    maxConsecutiveLosses: 3,
    maxLossRatePercent: 70,
    pnlVelocityThresholdUsd: -100,
    windowMinutes: 60,
    cooldownMinutes: 5,
    ...overrides,
  };
}

describe('CircuitBreaker', () => {
  it('starts in closed state and allows trades', () => {
    const breaker = new CircuitBreaker(makeConfig());
    const result = breaker.check();
    expect(result.allowed).toBe(true);
    expect(result.state).toBe('closed');
  });

  it('allows all when disabled', () => {
    const breaker = new CircuitBreaker(makeConfig({ enabled: false }));
    breaker.trip('manual');
    const result = breaker.check();
    expect(result.allowed).toBe(true);
  });

  it('trips on consecutive losses', () => {
    const breaker = new CircuitBreaker(makeConfig({ maxConsecutiveLosses: 3 }));

    breaker.recordOutcome({ pnl: -10, token: 'a' });
    breaker.recordOutcome({ pnl: -10, token: 'a' });
    expect(breaker.check().allowed).toBe(true);

    breaker.recordOutcome({ pnl: -10, token: 'a' });
    expect(breaker.check().allowed).toBe(false);
    expect(breaker.getState()).toBe('open');
  });

  it('resets consecutive losses on a win', () => {
    const breaker = new CircuitBreaker(makeConfig({ maxConsecutiveLosses: 3, maxLossRatePercent: 100 }));

    breaker.recordOutcome({ pnl: -10, token: 'a' });
    breaker.recordOutcome({ pnl: -10, token: 'a' });
    breaker.recordOutcome({ pnl: 5, token: 'a' }); // win resets count
    breaker.recordOutcome({ pnl: -10, token: 'a' });

    expect(breaker.check().allowed).toBe(true);
  });

  it('trips on loss rate exceeding threshold', () => {
    const breaker = new CircuitBreaker(makeConfig({ maxConsecutiveLosses: 100, maxLossRatePercent: 60 }));

    // 3 losses out of 4 = 75% > 60%
    breaker.recordOutcome({ pnl: -10, token: 'a' });
    breaker.recordOutcome({ pnl: 5, token: 'a' });
    breaker.recordOutcome({ pnl: -10, token: 'a' });
    breaker.recordOutcome({ pnl: -10, token: 'a' });

    expect(breaker.getState()).toBe('open');
    expect(breaker.check().trip).toContain('Loss rate');
  });

  it('transitions to half_open after cooldown', () => {
    const breaker = new CircuitBreaker(makeConfig({ cooldownMinutes: 1 }));

    breaker.trip('test trip');
    expect(breaker.check().allowed).toBe(false);

    // Fast-forward past cooldown
    vi.useFakeTimers();
    vi.advanceTimersByTime(2 * 60 * 1000);

    const result = breaker.check();
    expect(result.allowed).toBe(true);
    expect(result.state).toBe('half_open');

    vi.useRealTimers();
  });

  it('closes from half_open on success', () => {
    const breaker = new CircuitBreaker(makeConfig({ cooldownMinutes: 0 }));

    breaker.trip('test');
    // Immediately expired since cooldown is 0
    vi.useFakeTimers();
    vi.advanceTimersByTime(1);
    breaker.check(); // triggers half_open
    vi.useRealTimers();

    breaker.recordOutcome({ pnl: 5, token: 'a' });
    expect(breaker.getState()).toBe('closed');
  });

  it('re-opens from half_open on failure', () => {
    const breaker = new CircuitBreaker(makeConfig({ cooldownMinutes: 0 }));

    breaker.trip('test');
    vi.useFakeTimers();
    vi.advanceTimersByTime(1);
    breaker.check(); // triggers half_open
    vi.useRealTimers();

    breaker.recordOutcome({ pnl: -10, token: 'a' });
    expect(breaker.getState()).toBe('open');
  });
});
