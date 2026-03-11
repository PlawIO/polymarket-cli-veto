export type EconomicActionCategory = 'trade' | 'x402_research';
export type EconomicAuthoritySource = 'cloud' | 'cached_preview' | 'disabled';
export type BudgetScopeName = 'session' | 'agent' | 'category';

export interface EconomicScopeBudget {
  limitUsd?: number;
  spentUsd?: number;
  remainingUsd?: number;
}

export interface EconomicBudgetSnapshot {
  currency: string;
  asOf: string;
  source: EconomicAuthoritySource;
  stale?: boolean;
  session?: EconomicScopeBudget;
  agent?: EconomicScopeBudget;
  categories?: Record<string, EconomicScopeBudget>;
}

export interface EconomicAuthorizationRequest {
  actionId: string;
  sessionId: string;
  agentId: string;
  toolName: string;
  category: EconomicActionCategory;
  provider?: string;
  resourceId?: string;
  payer?: string;
  mode: 'live' | 'simulation';
  estimatedSpendUsd: number;
  maxAcceptableSpendUsd?: number;
  budgetScopes: BudgetScopeName[];
  metadata?: Record<string, unknown>;
}

export interface EconomicCommitRequest {
  actionId: string;
  sessionId: string;
  agentId: string;
  toolName: string;
  category: EconomicActionCategory;
  provider?: string;
  resourceId?: string;
  payer?: string;
  quotedSpendUsd?: number;
  actualSpendUsd: number;
  approvalId?: string;
  metadata?: Record<string, unknown>;
}

export interface EconomicDecision {
  decision: 'allow' | 'deny' | 'require_approval';
  reasonCode: string;
  message: string;
  approvalId?: string;
  authority: EconomicAuthoritySource;
  provisional?: boolean;
  payer?: string;
  provider?: string;
  resourceId?: string;
  quotedSpendUsd?: number;
  budget?: EconomicBudgetSnapshot;
}

export interface EconomicReceipt {
  status: 'disabled' | 'preview' | 'committed' | 'commit_failed';
  authority: EconomicAuthoritySource;
  category: EconomicActionCategory;
  payer?: string;
  provider?: string;
  resourceId?: string;
  quotedSpendUsd?: number;
  actualSpendUsd?: number;
  approvalId?: string;
  provisional?: boolean;
  reasonCode?: string;
  message?: string;
  budget?: EconomicBudgetSnapshot;
}

export interface EconomicBudgetStatus {
  enabled: boolean;
  authority: EconomicAuthoritySource;
  healthy: boolean;
  pendingApprovals: string[];
  budget?: EconomicBudgetSnapshot;
}

export interface EconomicConfig {
  enabled: boolean;
  defaultPayer?: string;
  approvedPayers: string[];
  scopes: BudgetScopeName[];
  cloud: {
    baseUrl: string;
    apiKeyEnv: string;
    timeoutMs: number;
    cacheTtlMs: number;
  };
}

export interface X402ToolServiceConfig {
  enabled: boolean;
  url: string;
  method: 'GET' | 'POST';
  provider: string;
  budgetCategory: string;
  maxPriceUsd?: number;
  payer?: string;
  queryParam: string;
  marketParam: string;
  eventParam: string;
  tokenParam: string;
  allowedNetworks: string[];
  allowedAssets: string[];
}

export interface X402Config {
  enabled: boolean;
  evmPrivateKeyEnv: string;
  tools: {
    intelSearch: X402ToolServiceConfig;
    intelMarketContext: X402ToolServiceConfig;
  };
}

export interface EconomicCloudClient {
  authorize(request: EconomicAuthorizationRequest): Promise<EconomicDecision>;
  commit(request: EconomicCommitRequest): Promise<EconomicReceipt>;
  status(input: { sessionId: string; agentId: string }): Promise<EconomicBudgetStatus>;
}

interface CachedBudgetState {
  snapshot: EconomicBudgetSnapshot;
  cachedAt: number;
}

interface EconomicAuthorizerDeps {
  client?: EconomicCloudClient;
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeScope(raw: unknown): EconomicScopeBudget | undefined {
  const row = asRecord(raw);
  const limitUsd = optionalNumber(row.limitUsd);
  const spentUsd = optionalNumber(row.spentUsd);
  const remainingUsd = optionalNumber(row.remainingUsd);
  if (limitUsd === undefined && spentUsd === undefined && remainingUsd === undefined) {
    return undefined;
  }
  return { limitUsd, spentUsd, remainingUsd };
}

function normalizeBudget(raw: unknown, source: EconomicAuthoritySource, stale?: boolean): EconomicBudgetSnapshot | undefined {
  const row = asRecord(raw);
  const currency = optionalString(row.currency) ?? 'USD';
  const asOf = optionalString(row.asOf) ?? new Date().toISOString();
  const categoriesRaw = asRecord(row.categories);
  const categories: Record<string, EconomicScopeBudget> = {};

  for (const [key, value] of Object.entries(categoriesRaw)) {
    const normalized = normalizeScope(value);
    if (normalized) {
      categories[key] = normalized;
    }
  }

  const budget: EconomicBudgetSnapshot = {
    currency,
    asOf,
    source,
    stale,
    session: normalizeScope(row.session),
    agent: normalizeScope(row.agent),
    categories: Object.keys(categories).length > 0 ? categories : undefined,
  };

  if (!budget.session && !budget.agent && !budget.categories) {
    return undefined;
  }

  return budget;
}

class RemoteEconomicClient implements EconomicCloudClient {
  constructor(
    private readonly config: EconomicConfig,
    private readonly now: () => number,
  ) {}

  async authorize(request: EconomicAuthorizationRequest): Promise<EconomicDecision> {
    const body = await this.post('/v1/economic/authorize', request);
    return this.normalizeDecision(body, request);
  }

  async commit(request: EconomicCommitRequest): Promise<EconomicReceipt> {
    const body = await this.post('/v1/economic/commit', request);
    const row = asRecord(body);
    return {
      status: 'committed',
      authority: 'cloud',
      category: request.category,
      payer: optionalString(row.payer) ?? request.payer,
      provider: optionalString(row.provider) ?? request.provider,
      resourceId: optionalString(row.resourceId) ?? request.resourceId,
      quotedSpendUsd: optionalNumber(row.quotedSpendUsd) ?? request.quotedSpendUsd,
      actualSpendUsd: optionalNumber(row.actualSpendUsd) ?? request.actualSpendUsd,
      approvalId: optionalString(row.approvalId) ?? request.approvalId,
      reasonCode: optionalString(row.reasonCode),
      message: optionalString(row.message),
      budget: normalizeBudget(row.budget, 'cloud'),
    };
  }

  async status(input: { sessionId: string; agentId: string }): Promise<EconomicBudgetStatus> {
    const body = await this.post('/v1/economic/status', input);
    const row = asRecord(body);
    const pending = Array.isArray(row.pendingApprovals)
      ? row.pendingApprovals.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];

    return {
      enabled: true,
      authority: 'cloud',
      healthy: true,
      pendingApprovals: pending,
      budget: normalizeBudget(row.budget, 'cloud'),
    };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const apiKey = process.env[this.config.cloud.apiKeyEnv]?.trim();
    if (!apiKey) {
      throw new Error(`Missing ${this.config.cloud.apiKeyEnv}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.cloud.timeoutMs);

    try {
      const response = await fetch(`${this.config.cloud.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-veto-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`status ${response.status}${detail ? `: ${detail}` : ''}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private normalizeDecision(raw: unknown, request: EconomicAuthorizationRequest): EconomicDecision {
    const row = asRecord(raw);
    const decision = optionalString(row.decision);
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'require_approval') {
      throw new Error('Invalid economic decision payload');
    }

    return {
      decision,
      reasonCode: optionalString(row.reasonCode) ?? 'economic_authorized',
      message: optionalString(row.message) ?? 'Economic authorization granted',
      approvalId: optionalString(row.approvalId),
      authority: 'cloud',
      provisional: false,
      payer: optionalString(row.payer) ?? request.payer,
      provider: optionalString(row.provider) ?? request.provider,
      resourceId: optionalString(row.resourceId) ?? request.resourceId,
      quotedSpendUsd: optionalNumber(row.quotedSpendUsd) ?? request.estimatedSpendUsd,
      budget: normalizeBudget(row.budget, 'cloud'),
    };
  }
}

export class EconomicAuthorizer {
  private readonly client: EconomicCloudClient;
  private readonly now: () => number;
  private cachedBudget: CachedBudgetState | null = null;
  private readonly pendingApprovals = new Set<string>();

  constructor(
    private readonly config: EconomicConfig,
    deps: EconomicAuthorizerDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.client = deps.client ?? new RemoteEconomicClient(config, this.now);
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async authorize(request: EconomicAuthorizationRequest): Promise<EconomicDecision> {
    if (!this.config.enabled) {
      return {
        decision: 'allow',
        reasonCode: 'economic_disabled',
        message: 'Economic authorization disabled',
        authority: 'disabled',
        quotedSpendUsd: request.estimatedSpendUsd,
        payer: request.payer ?? this.config.defaultPayer,
        provider: request.provider,
        resourceId: request.resourceId,
      };
    }

    const payer = optionalString(request.payer) ?? this.config.defaultPayer;
    if (!payer) {
      return {
        decision: 'deny',
        reasonCode: 'payer_missing',
        message: 'Economic authorization requires a payer',
        authority: 'cloud',
        quotedSpendUsd: request.estimatedSpendUsd,
        provider: request.provider,
        resourceId: request.resourceId,
      };
    }

    if (this.config.approvedPayers.length > 0 && !this.config.approvedPayers.includes(payer)) {
      return {
        decision: 'deny',
        reasonCode: 'payer_not_allowed',
        message: `Payer '${payer}' is not approved`,
        authority: 'cloud',
        payer,
        quotedSpendUsd: request.estimatedSpendUsd,
        provider: request.provider,
        resourceId: request.resourceId,
      };
    }

    try {
      const decision = await this.client.authorize({
        ...request,
        payer,
      });
      this.maybeCacheBudget(decision.budget);
      if (decision.approvalId) {
        this.pendingApprovals.add(decision.approvalId);
      }
      return {
        ...decision,
        payer: decision.payer ?? payer,
        provider: decision.provider ?? request.provider,
        resourceId: decision.resourceId ?? request.resourceId,
        quotedSpendUsd: decision.quotedSpendUsd ?? request.estimatedSpendUsd,
      };
    } catch (error) {
      const cachedBudget = request.mode === 'simulation' ? this.getCachedBudget() : undefined;
      if (cachedBudget) {
        return {
          decision: 'allow',
          reasonCode: 'economic_authority_unavailable',
          message: 'Economic authority unavailable; using cached preview',
          authority: 'cached_preview',
          provisional: true,
          payer,
          provider: request.provider,
          resourceId: request.resourceId,
          quotedSpendUsd: request.estimatedSpendUsd,
          budget: cachedBudget,
        };
      }

      return {
        decision: 'deny',
        reasonCode: 'economic_authority_unavailable',
        message: `Economic authority unavailable: ${error instanceof Error ? error.message : String(error)}`,
        authority: 'cloud',
        payer,
        provider: request.provider,
        resourceId: request.resourceId,
        quotedSpendUsd: request.estimatedSpendUsd,
      };
    }
  }

  async commit(request: EconomicCommitRequest): Promise<EconomicReceipt> {
    if (!this.config.enabled) {
      return {
        status: 'disabled',
        authority: 'disabled',
        category: request.category,
        payer: request.payer ?? this.config.defaultPayer,
        provider: request.provider,
        resourceId: request.resourceId,
        quotedSpendUsd: request.quotedSpendUsd,
        actualSpendUsd: request.actualSpendUsd,
        approvalId: request.approvalId,
      };
    }

    try {
      const receipt = await this.client.commit(request);
      this.maybeCacheBudget(receipt.budget);
      if (request.approvalId) {
        this.pendingApprovals.delete(request.approvalId);
      }
      return receipt;
    } catch (error) {
      return {
        status: 'commit_failed',
        authority: 'cloud',
        category: request.category,
        payer: request.payer ?? this.config.defaultPayer,
        provider: request.provider,
        resourceId: request.resourceId,
        quotedSpendUsd: request.quotedSpendUsd,
        actualSpendUsd: request.actualSpendUsd,
        approvalId: request.approvalId,
        reasonCode: 'economic_commit_failed',
        message: `Economic commit failed: ${error instanceof Error ? error.message : String(error)}`,
        budget: this.getCachedBudget(),
      };
    }
  }

  async getBudgetStatus(input: { sessionId: string; agentId: string }): Promise<EconomicBudgetStatus> {
    if (!this.config.enabled) {
      return {
        enabled: false,
        authority: 'disabled',
        healthy: true,
        pendingApprovals: [...this.pendingApprovals],
        budget: this.getCachedBudget(),
      };
    }

    try {
      const status = await this.client.status(input);
      this.maybeCacheBudget(status.budget);
      for (const approvalId of status.pendingApprovals) {
        this.pendingApprovals.add(approvalId);
      }
      return {
        ...status,
        pendingApprovals: [...this.pendingApprovals],
      };
    } catch {
      const cachedBudget = this.getCachedBudget();
      return {
        enabled: true,
        authority: cachedBudget ? 'cached_preview' : 'cloud',
        healthy: false,
        pendingApprovals: [...this.pendingApprovals],
        budget: cachedBudget,
      };
    }
  }

  markApprovalResolved(approvalId?: string): void {
    if (!approvalId) return;
    this.pendingApprovals.delete(approvalId);
  }

  trackPendingApproval(approvalId?: string): void {
    if (!approvalId) return;
    this.pendingApprovals.add(approvalId);
  }

  getPendingApprovals(): string[] {
    return [...this.pendingApprovals];
  }

  private getCachedBudget(): EconomicBudgetSnapshot | undefined {
    if (!this.cachedBudget) return undefined;
    if (this.now() - this.cachedBudget.cachedAt > this.config.cloud.cacheTtlMs) {
      return undefined;
    }
    return {
      ...this.cachedBudget.snapshot,
      stale: true,
      source: 'cached_preview',
    };
  }

  private maybeCacheBudget(budget: EconomicBudgetSnapshot | undefined): void {
    if (!budget) return;
    this.cachedBudget = {
      snapshot: {
        ...budget,
        source: 'cloud',
        stale: false,
      },
      cachedAt: this.now(),
    };
  }
}
