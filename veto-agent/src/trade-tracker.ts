export interface TradeRecord {
  timestamp: string;
  toolName: string;
  token: string;
  side: 'buy' | 'sell';
  amountUsd: number;
  agentId: string;
}

export interface TradeLimitsConfig {
  enabled: boolean;
  maxPositionSizeUsd: number;
  dailyVolumeLimitUsd: number;
}

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
}

export class TradeTracker {
  private trades: TradeRecord[] = [];

  record(trade: TradeRecord): void {
    this.trades.push(trade);
  }

  dailyVolumeUsd(agentId: string, now?: Date): number {
    const ref = now ?? new Date();
    const cutoff = new Date(ref.getTime() - 24 * 60 * 60 * 1000);
    const cutoffIso = cutoff.toISOString();

    return this.trades
      .filter((t) => t.agentId === agentId && t.timestamp >= cutoffIso)
      .reduce((sum, t) => sum + t.amountUsd, 0);
  }

  positionSizeUsd(token: string, agentId: string): number {
    return this.trades
      .filter((t) => t.token === token && t.agentId === agentId)
      .reduce((sum, t) => (t.side === 'buy' ? sum + t.amountUsd : sum - t.amountUsd), 0);
  }

  checkLimits(
    trade: { token: string; amountUsd: number; agentId: string; side: 'buy' | 'sell' },
    limits: TradeLimitsConfig,
  ): LimitCheckResult {
    if (!limits.enabled) return { allowed: true };

    const dailyVolume = this.dailyVolumeUsd(trade.agentId) + trade.amountUsd;
    if (dailyVolume > limits.dailyVolumeLimitUsd) {
      return {
        allowed: false,
        reason: `Daily volume $${dailyVolume.toFixed(2)} would exceed limit of $${limits.dailyVolumeLimitUsd}`,
      };
    }

    const currentPosition = this.positionSizeUsd(trade.token, trade.agentId);
    const projectedPosition =
      trade.side === 'buy' ? currentPosition + trade.amountUsd : currentPosition - trade.amountUsd;

    if (Math.abs(projectedPosition) > limits.maxPositionSizeUsd) {
      return {
        allowed: false,
        reason: `Position size $${Math.abs(projectedPosition).toFixed(2)} would exceed limit of $${limits.maxPositionSizeUsd}`,
      };
    }

    return { allowed: true };
  }
}
