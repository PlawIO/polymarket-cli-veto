export interface MarketAccessConfig {
  enabled: boolean;
  mode: 'allowlist' | 'blocklist';
  tokens: string[];
  categories: string[];
  minLiquidityUsd?: number;
}

export interface MarketAccessResult {
  allowed: boolean;
  reason?: string;
}

export class MarketAccessControl {
  constructor(private readonly config: MarketAccessConfig) {}

  check(token: string, metadata?: { category?: string; liquidityUsd?: number }): MarketAccessResult {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    if (this.config.mode === 'allowlist') {
      if (!this.config.tokens.includes(token)) {
        return { allowed: false, reason: `Token '${token}' not in allowlist` };
      }
    } else {
      if (this.config.tokens.includes(token)) {
        return { allowed: false, reason: `Token '${token}' is blocklisted` };
      }
    }

    if (metadata?.category && this.config.categories.length > 0) {
      if (this.config.mode === 'allowlist') {
        if (!this.config.categories.includes(metadata.category)) {
          return { allowed: false, reason: `Category '${metadata.category}' not in allowlist` };
        }
      } else {
        if (this.config.categories.includes(metadata.category)) {
          return { allowed: false, reason: `Category '${metadata.category}' is blocklisted` };
        }
      }
    }

    if (
      this.config.minLiquidityUsd !== undefined &&
      metadata?.liquidityUsd !== undefined &&
      metadata.liquidityUsd < this.config.minLiquidityUsd
    ) {
      return {
        allowed: false,
        reason: `Liquidity $${metadata.liquidityUsd} below minimum $${this.config.minLiquidityUsd}`,
      };
    }

    return { allowed: true };
  }
}
