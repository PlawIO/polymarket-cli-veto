import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Position {
  token: string;
  side: 'buy' | 'sell';
  shares: number;
  costBasisUsd: number;
  entryPrice: number;
  entryTimestamp: string;
}

export interface PnlSnapshot {
  positions: Array<Position & { currentPrice?: number; unrealizedPnl?: number }>;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalPnl: number;
}

export interface PositionTrackerConfig {
  enabled: boolean;
  dataFilePath: string;
}

export class PositionTracker {
  private positions = new Map<string, Position>();
  private midpoints = new Map<string, number>();
  private realizedPnl = 0;

  constructor(private readonly config: PositionTrackerConfig) {}

  recordTrade(trade: {
    token: string;
    side: 'buy' | 'sell';
    shares: number;
    priceUsd: number;
    amountUsd: number;
  }): void {
    if (!this.config.enabled) return;

    const existing = this.positions.get(trade.token);

    if (!existing) {
      this.positions.set(trade.token, {
        token: trade.token,
        side: trade.side,
        shares: trade.shares,
        costBasisUsd: trade.amountUsd,
        entryPrice: trade.priceUsd,
        entryTimestamp: new Date().toISOString(),
      });
      this.save();
      return;
    }

    if (trade.side === existing.side) {
      const totalShares = existing.shares + trade.shares;
      const totalCost = existing.costBasisUsd + trade.amountUsd;
      existing.shares = totalShares;
      existing.costBasisUsd = totalCost;
      existing.entryPrice = totalCost / totalShares;
    } else {
      const sharesToClose = Math.min(trade.shares, existing.shares);
      const avgCostPerShare = existing.costBasisUsd / existing.shares;
      const pnl = sharesToClose * (trade.priceUsd - avgCostPerShare);
      this.realizedPnl += pnl;

      existing.shares -= sharesToClose;
      existing.costBasisUsd -= sharesToClose * avgCostPerShare;

      if (existing.shares <= 0) {
        const remainingShares = trade.shares - sharesToClose;
        if (remainingShares > 0) {
          this.positions.set(trade.token, {
            token: trade.token,
            side: trade.side,
            shares: remainingShares,
            costBasisUsd: remainingShares * trade.priceUsd,
            entryPrice: trade.priceUsd,
            entryTimestamp: new Date().toISOString(),
          });
        } else {
          this.positions.delete(trade.token);
        }
      }
    }

    this.save();
  }

  updateMidpoint(token: string, price: number): void {
    this.midpoints.set(token, price);
  }

  getSnapshot(): PnlSnapshot {
    let totalUnrealizedPnl = 0;
    const positions: PnlSnapshot['positions'] = [];

    for (const pos of this.positions.values()) {
      const currentPrice = this.midpoints.get(pos.token);
      let unrealizedPnl: number | undefined;

      if (currentPrice !== undefined && pos.shares > 0) {
        const avgCost = pos.costBasisUsd / pos.shares;
        if (pos.side === 'buy') {
          unrealizedPnl = pos.shares * (currentPrice - avgCost);
        } else {
          unrealizedPnl = pos.shares * (avgCost - currentPrice);
        }
        totalUnrealizedPnl += unrealizedPnl;
      }

      positions.push({ ...pos, currentPrice, unrealizedPnl });
    }

    return {
      positions,
      totalRealizedPnl: this.realizedPnl,
      totalUnrealizedPnl,
      totalPnl: this.realizedPnl + totalUnrealizedPnl,
    };
  }

  getTotalPnl(): number {
    return this.getSnapshot().totalPnl;
  }

  getPosition(token: string): Position | undefined {
    return this.positions.get(token);
  }

  save(): void {
    if (!this.config.enabled) return;
    try {
      mkdirSync(dirname(this.config.dataFilePath), { recursive: true });
      const data = {
        positions: Array.from(this.positions.values()),
        realizedPnl: this.realizedPnl,
        midpoints: Object.fromEntries(this.midpoints),
      };
      writeFileSync(this.config.dataFilePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Don't break trading on persistence failure
    }
  }

  load(): void {
    if (!this.config.enabled || !existsSync(this.config.dataFilePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.config.dataFilePath, 'utf-8')) as {
        positions?: Position[];
        realizedPnl?: number;
        midpoints?: Record<string, number>;
      };

      if (Array.isArray(raw.positions)) {
        for (const pos of raw.positions) {
          this.positions.set(pos.token, pos);
        }
      }
      if (typeof raw.realizedPnl === 'number') {
        this.realizedPnl = raw.realizedPnl;
      }
      if (raw.midpoints && typeof raw.midpoints === 'object') {
        for (const [token, price] of Object.entries(raw.midpoints)) {
          if (typeof price === 'number') {
            this.midpoints.set(token, price);
          }
        }
      }
    } catch {
      // Start fresh on corrupted data
    }
  }
}
