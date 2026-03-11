import type { PositionTracker } from './position-tracker.js';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  enabled: boolean;
  maxConsecutiveLosses: number;
  maxLossRatePercent: number;
  pnlVelocityThresholdUsd: number;
  windowMinutes: number;
  cooldownMinutes: number;
}

interface Outcome {
  pnl: number;
  token: string;
  timestamp: number;
}

export interface BreakerCheckResult {
  allowed: boolean;
  state: BreakerState;
  trip?: string;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private outcomes: Outcome[] = [];
  private consecutiveLosses = 0;
  private tripReason?: string;
  private tripExpiry?: number;

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly positionTracker?: PositionTracker,
  ) {}

  check(): BreakerCheckResult {
    if (!this.config.enabled) {
      return { allowed: true, state: 'closed' };
    }

    if (this.state === 'open') {
      if (this.tripExpiry && Date.now() >= this.tripExpiry) {
        this.state = 'half_open';
        return { allowed: true, state: 'half_open' };
      }
      return { allowed: false, state: 'open', trip: this.tripReason };
    }

    if (this.positionTracker) {
      const windowMs = this.config.windowMinutes * 60 * 1000;
      const cutoff = Date.now() - windowMs;
      const recentOutcomes = this.outcomes.filter((o) => o.timestamp >= cutoff);
      const recentPnl = recentOutcomes.reduce((sum, o) => sum + o.pnl, 0);

      if (recentPnl <= this.config.pnlVelocityThresholdUsd) {
        this.trip(
          `P&L velocity $${recentPnl.toFixed(2)} breached threshold $${this.config.pnlVelocityThresholdUsd}`,
        );
        return { allowed: false, state: 'open', trip: this.tripReason };
      }
    }

    return { allowed: true, state: this.state };
  }

  recordOutcome(outcome: { pnl: number; token: string; timestamp?: number }): void {
    if (!this.config.enabled) return;

    const ts = outcome.timestamp ?? Date.now();
    this.outcomes.push({ ...outcome, timestamp: ts });

    const windowMs = this.config.windowMinutes * 60 * 1000;
    const cutoff = ts - windowMs;
    this.outcomes = this.outcomes.filter((o) => o.timestamp >= cutoff);

    if (outcome.pnl < 0) {
      this.consecutiveLosses++;
    } else {
      this.consecutiveLosses = 0;
    }

    if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.trip(`${this.consecutiveLosses} consecutive losses`);
      return;
    }

    const windowOutcomes = this.outcomes.filter((o) => o.timestamp >= cutoff);
    if (windowOutcomes.length >= 3) {
      const losses = windowOutcomes.filter((o) => o.pnl < 0).length;
      const lossRate = (losses / windowOutcomes.length) * 100;
      if (lossRate >= this.config.maxLossRatePercent) {
        this.trip(`Loss rate ${lossRate.toFixed(0)}% exceeds ${this.config.maxLossRatePercent}%`);
        return;
      }
    }

    if (this.state === 'half_open') {
      if (outcome.pnl >= 0) {
        this.reset();
      } else {
        this.trip('Loss during half-open state');
      }
    }
  }

  trip(reason: string): void {
    this.state = 'open';
    this.tripReason = reason;
    this.tripExpiry = Date.now() + this.config.cooldownMinutes * 60 * 1000;
  }

  reset(): void {
    this.state = 'closed';
    this.tripReason = undefined;
    this.tripExpiry = undefined;
    this.consecutiveLosses = 0;
  }

  getState(): BreakerState {
    return this.state;
  }

  getStatus(): {
    state: BreakerState;
    tripReason?: string;
    tripExpiry?: number;
    consecutiveLosses: number;
    recentOutcomes: number;
  } {
    return {
      state: this.state,
      tripReason: this.tripReason,
      tripExpiry: this.tripExpiry,
      consecutiveLosses: this.consecutiveLosses,
      recentOutcomes: this.outcomes.length,
    };
  }
}
