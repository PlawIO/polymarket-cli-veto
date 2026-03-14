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

export interface MarketAccessMetadata {
  category?: string;
  liquidityUsd?: number;
}

export class MarketAccessControl {
  constructor(private readonly config: MarketAccessConfig) {}

  getMetadata(metadata?: { category?: unknown; liquidityUsd?: unknown }): MarketAccessMetadata | undefined {
    if (!metadata) {
      return undefined;
    }

    const category = typeof metadata.category === 'string' && metadata.category.trim().length > 0
      ? metadata.category.trim()
      : undefined;
    const liquidityUsd = typeof metadata.liquidityUsd === 'number' && Number.isFinite(metadata.liquidityUsd)
      ? metadata.liquidityUsd
      : undefined;

    if (category === undefined && liquidityUsd === undefined) {
      return undefined;
    }

    return {
      category,
      liquidityUsd,
    };
  }

  check(token: string, metadata?: MarketAccessMetadata): MarketAccessResult {
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
