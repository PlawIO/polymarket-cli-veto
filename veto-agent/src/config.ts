import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BudgetScopeName, X402ToolServiceConfig } from './economic.js';
import { POLICY_PROFILES, type ApprovalMode, type McpTransport, type PolicyProfile, type ResolvedConfig, type SidecarConfig } from './types.js';

const DEFAULT_CONFIG_PATHS = [
  'veto-agent/polymarket-veto.config.yaml',
  'polymarket-veto.config.yaml',
];

const DEFAULTS: SidecarConfig = {
  polymarket: {
    binaryPath: 'auto',
  },
  runtime: {
    agentIdEnv: 'VETO_AGENT_ID',
    sessionIdEnv: 'VETO_SESSION_ID',
    approvalMode: 'wait',
  },
  execution: {
    simulationDefault: true,
    allowLiveTrades: false,
    maxCommandTimeoutMs: 15_000,
    maxOutputBytes: 1_048_576,
    tradeLimits: {
      enabled: true,
      maxPositionSizeUsd: 500,
      dailyVolumeLimitUsd: 1000,
    },
    marketAccess: {
      enabled: false,
      mode: 'blocklist',
      tokens: [],
      categories: [],
    },
    circuitBreaker: {
      enabled: false,
      maxConsecutiveLosses: 5,
      maxLossRatePercent: 70,
      pnlVelocityThresholdUsd: -100,
      windowMinutes: 60,
      cooldownMinutes: 15,
    },
  },
  audit: {
    enabled: true,
    filePath: './data/audit.jsonl',
    maxFileSizeMb: 50,
  },
  positions: {
    enabled: true,
    dataFilePath: './data/positions.json',
  },
  mcp: {
    transport: 'stdio',
    host: '127.0.0.1',
    port: 9800,
    path: '/mcp',
  },
  veto: {
    configDir: '../veto',
    policyProfile: 'defaults',
    cloud: {
      apiKeyEnv: 'VETO_API_KEY',
    },
    multiSig: {
      enabled: false,
      minApprovals: 2,
      thresholdUsd: 100,
      approvalTimeoutMs: 600_000,
    },
    identity: {
      enabled: false,
      algorithm: 'sha256',
      agents: [],
    },
  },
  economic: {
    enabled: false,
    approvedPayers: [],
    scopes: ['session', 'agent', 'category'],
    cloud: {
      baseUrl: 'https://api.veto.so',
      apiKeyEnv: 'VETO_API_KEY',
      timeoutMs: 10_000,
      cacheTtlMs: 30_000,
    },
  },
  x402: {
    enabled: false,
    evmPrivateKeyEnv: 'X402_EVM_PRIVATE_KEY',
    tools: {
      intelSearch: {
        enabled: false,
        url: '',
        method: 'GET',
        provider: 'intel-search',
        budgetCategory: 'research',
        maxPriceUsd: 0.05,
        queryParam: 'q',
        marketParam: 'market',
        eventParam: 'event',
        tokenParam: 'token',
        allowedNetworks: ['eip155:8453'],
        allowedAssets: ['USDC'],
      },
      intelMarketContext: {
        enabled: false,
        url: '',
        method: 'GET',
        provider: 'intel-market-context',
        budgetCategory: 'research',
        maxPriceUsd: 0.1,
        queryParam: 'q',
        marketParam: 'market',
        eventParam: 'event',
        tokenParam: 'token',
        allowedNetworks: ['eip155:8453'],
        allowedAssets: ['USDC'],
      },
    },
  },
};

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

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function optionalPositiveNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v) => typeof v === 'string' && v.trim().length > 0).map((v) => (v as string).trim());
}

function parseTransport(value: unknown, fallback: McpTransport): McpTransport {
  if (value === 'stdio' || value === 'sse') return value;
  return fallback;
}

function parsePolicyProfile(value: unknown, fallback: PolicyProfile): PolicyProfile {
  if (typeof value === 'string' && POLICY_PROFILES.includes(value as PolicyProfile)) {
    return value as PolicyProfile;
  }
  return fallback;
}

function parseAccessMode(value: unknown, fallback: 'allowlist' | 'blocklist'): 'allowlist' | 'blocklist' {
  if (value === 'allowlist' || value === 'blocklist') return value;
  return fallback;
}

function parseAlgorithm(value: unknown, fallback: 'sha256' | 'sha512'): 'sha256' | 'sha512' {
  if (value === 'sha256' || value === 'sha512') return value;
  return fallback;
}

function parseBudgetScopes(value: unknown, fallback: BudgetScopeName[]): BudgetScopeName[] {
  if (!Array.isArray(value)) return fallback;
  const scopes = value.filter((entry): entry is BudgetScopeName => (
    entry === 'session' || entry === 'agent' || entry === 'category'
  ));
  return scopes.length > 0 ? scopes : fallback;
}

function parseMethod(value: unknown, fallback: 'GET' | 'POST'): 'GET' | 'POST' {
  if (value === 'GET' || value === 'POST') return value;
  return fallback;
}

function parseApprovalMode(value: unknown, fallback: ApprovalMode): ApprovalMode {
  if (value === 'wait' || value === 'return') return value;
  return fallback;
}

function mergeX402ToolConfig(raw: unknown, base: X402ToolServiceConfig): X402ToolServiceConfig {
  const row = asRecord(raw);
  return {
    enabled: optionalBoolean(row.enabled) ?? base.enabled,
    url: optionalString(row.url) ?? base.url,
    method: parseMethod(row.method, base.method),
    provider: optionalString(row.provider) ?? base.provider,
    budgetCategory: optionalString(row.budgetCategory) ?? base.budgetCategory,
    maxPriceUsd: optionalPositiveNumber(row.maxPriceUsd) ?? base.maxPriceUsd,
    payer: optionalString(row.payer) ?? base.payer,
    queryParam: optionalString(row.queryParam) ?? base.queryParam,
    marketParam: optionalString(row.marketParam) ?? base.marketParam,
    eventParam: optionalString(row.eventParam) ?? base.eventParam,
    tokenParam: optionalString(row.tokenParam) ?? base.tokenParam,
    allowedNetworks: optionalStringArray(row.allowedNetworks) ?? base.allowedNetworks,
    allowedAssets: optionalStringArray(row.allowedAssets) ?? base.allowedAssets,
  };
}

function parseAgentsList(value: unknown): Array<{ agentId: string; secretEnv: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Array<{ agentId: string; secretEnv: string }> = [];
  for (const item of value) {
    const row = asRecord(item);
    const agentId = optionalString(row.agentId);
    const secretEnv = optionalString(row.secretEnv);
    if (agentId && secretEnv) {
      result.push({ agentId, secretEnv });
    }
  }
  return result.length > 0 ? result : undefined;
}

function merge(raw: unknown, base: SidecarConfig): SidecarConfig {
  const root = asRecord(raw);

  const polymarket = asRecord(root.polymarket);
  const runtime = asRecord(root.runtime);
  const execution = asRecord(root.execution);
  const mcp = asRecord(root.mcp);
  const veto = asRecord(root.veto);
  const cloud = asRecord(veto.cloud);
  const audit = asRecord(root.audit);
  const positions = asRecord(root.positions);
  const tradeLimits = asRecord(execution.tradeLimits);
  const marketAccess = asRecord(execution.marketAccess);
  const circuitBreaker = asRecord(execution.circuitBreaker);
  const multiSig = asRecord(veto.multiSig);
  const identity = asRecord(veto.identity);
  const economic = asRecord(root.economic);
  const economicCloud = asRecord(economic.cloud);
  const x402 = asRecord(root.x402);
  const x402Tools = asRecord(x402.tools);

  return {
    polymarket: {
      binaryPath: optionalString(polymarket.binaryPath) ?? base.polymarket.binaryPath,
    },
    runtime: {
      agentId: optionalString(runtime.agentId) ?? base.runtime.agentId,
      agentIdEnv: optionalString(runtime.agentIdEnv) ?? base.runtime.agentIdEnv,
      sessionId: optionalString(runtime.sessionId) ?? base.runtime.sessionId,
      sessionIdEnv: optionalString(runtime.sessionIdEnv) ?? base.runtime.sessionIdEnv,
      approvalMode: parseApprovalMode(runtime.approvalMode, base.runtime.approvalMode),
    },
    execution: {
      simulationDefault: optionalBoolean(execution.simulationDefault) ?? base.execution.simulationDefault,
      allowLiveTrades: optionalBoolean(execution.allowLiveTrades) ?? base.execution.allowLiveTrades,
      maxCommandTimeoutMs: optionalPositiveInt(execution.maxCommandTimeoutMs) ?? base.execution.maxCommandTimeoutMs,
      maxOutputBytes: optionalPositiveInt(execution.maxOutputBytes) ?? base.execution.maxOutputBytes,
      tradeLimits: {
        enabled: optionalBoolean(tradeLimits.enabled) ?? base.execution.tradeLimits.enabled,
        maxPositionSizeUsd: optionalPositiveNumber(tradeLimits.maxPositionSizeUsd) ?? base.execution.tradeLimits.maxPositionSizeUsd,
        dailyVolumeLimitUsd: optionalPositiveNumber(tradeLimits.dailyVolumeLimitUsd) ?? base.execution.tradeLimits.dailyVolumeLimitUsd,
      },
      marketAccess: {
        enabled: optionalBoolean(marketAccess.enabled) ?? base.execution.marketAccess.enabled,
        mode: parseAccessMode(marketAccess.mode, base.execution.marketAccess.mode),
        tokens: optionalStringArray(marketAccess.tokens) ?? base.execution.marketAccess.tokens,
        categories: optionalStringArray(marketAccess.categories) ?? base.execution.marketAccess.categories,
        minLiquidityUsd: optionalPositiveNumber(marketAccess.minLiquidityUsd) ?? base.execution.marketAccess.minLiquidityUsd,
      },
      circuitBreaker: {
        enabled: optionalBoolean(circuitBreaker.enabled) ?? base.execution.circuitBreaker.enabled,
        maxConsecutiveLosses: optionalPositiveInt(circuitBreaker.maxConsecutiveLosses) ?? base.execution.circuitBreaker.maxConsecutiveLosses,
        maxLossRatePercent: optionalPositiveNumber(circuitBreaker.maxLossRatePercent) ?? base.execution.circuitBreaker.maxLossRatePercent,
        pnlVelocityThresholdUsd: optionalNumber(circuitBreaker.pnlVelocityThresholdUsd) ?? base.execution.circuitBreaker.pnlVelocityThresholdUsd,
        windowMinutes: optionalPositiveInt(circuitBreaker.windowMinutes) ?? base.execution.circuitBreaker.windowMinutes,
        cooldownMinutes: optionalPositiveInt(circuitBreaker.cooldownMinutes) ?? base.execution.circuitBreaker.cooldownMinutes,
      },
    },
    audit: {
      enabled: optionalBoolean(audit.enabled) ?? base.audit.enabled,
      filePath: optionalString(audit.filePath) ?? base.audit.filePath,
      webhookUrl: optionalString(audit.webhookUrl) ?? base.audit.webhookUrl,
      maxFileSizeMb: optionalPositiveNumber(audit.maxFileSizeMb) ?? base.audit.maxFileSizeMb,
    },
    positions: {
      enabled: optionalBoolean(positions.enabled) ?? base.positions.enabled,
      dataFilePath: optionalString(positions.dataFilePath) ?? base.positions.dataFilePath,
    },
    mcp: {
      transport: parseTransport(mcp.transport, base.mcp.transport),
      host: optionalString(mcp.host) ?? base.mcp.host,
      port: optionalPositiveInt(mcp.port) ?? base.mcp.port,
      path: optionalString(mcp.path) ?? base.mcp.path,
    },
    veto: {
      configDir: optionalString(veto.configDir) ?? base.veto.configDir,
      policyProfile: parsePolicyProfile(veto.policyProfile, base.veto.policyProfile),
      cloud: {
        apiKeyEnv: optionalString(cloud.apiKeyEnv) ?? base.veto.cloud.apiKeyEnv,
      },
      multiSig: {
        enabled: optionalBoolean(multiSig.enabled) ?? base.veto.multiSig.enabled,
        minApprovals: optionalPositiveInt(multiSig.minApprovals) ?? base.veto.multiSig.minApprovals,
        thresholdUsd: optionalPositiveNumber(multiSig.thresholdUsd) ?? base.veto.multiSig.thresholdUsd,
        approvalTimeoutMs: optionalPositiveInt(multiSig.approvalTimeoutMs) ?? base.veto.multiSig.approvalTimeoutMs,
      },
      identity: {
        enabled: optionalBoolean(identity.enabled) ?? base.veto.identity.enabled,
        algorithm: parseAlgorithm(identity.algorithm, base.veto.identity.algorithm),
        agents: parseAgentsList(identity.agents) ?? base.veto.identity.agents,
      },
    },
    economic: {
      enabled: optionalBoolean(economic.enabled) ?? base.economic.enabled,
      defaultPayer: optionalString(economic.defaultPayer) ?? base.economic.defaultPayer,
      approvedPayers: optionalStringArray(economic.approvedPayers) ?? base.economic.approvedPayers,
      scopes: parseBudgetScopes(economic.scopes, base.economic.scopes),
      cloud: {
        baseUrl: optionalString(economicCloud.baseUrl) ?? base.economic.cloud.baseUrl,
        apiKeyEnv: optionalString(economicCloud.apiKeyEnv) ?? base.economic.cloud.apiKeyEnv,
        timeoutMs: optionalPositiveInt(economicCloud.timeoutMs) ?? base.economic.cloud.timeoutMs,
        cacheTtlMs: optionalPositiveInt(economicCloud.cacheTtlMs) ?? base.economic.cloud.cacheTtlMs,
      },
    },
    x402: {
      enabled: optionalBoolean(x402.enabled) ?? base.x402.enabled,
      evmPrivateKeyEnv: optionalString(x402.evmPrivateKeyEnv) ?? base.x402.evmPrivateKeyEnv,
      tools: {
        intelSearch: mergeX402ToolConfig(x402Tools.intelSearch, base.x402.tools.intelSearch),
        intelMarketContext: mergeX402ToolConfig(x402Tools.intelMarketContext, base.x402.tools.intelMarketContext),
      },
    },
  };
}

function findExistingConfigPath(explicitPath?: string): string | null {
  if (explicitPath) {
    const resolved = resolve(explicitPath);
    return existsSync(resolved) ? resolved : resolved;
  }

  for (const relative of DEFAULT_CONFIG_PATHS) {
    const candidate = resolve(relative);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function loadConfig(explicitPath?: string): ResolvedConfig {
  const resolvedPath = findExistingConfigPath(explicitPath);

  if (resolvedPath && existsSync(resolvedPath)) {
    const content = readFileSync(resolvedPath, 'utf-8');
    const parsed = parseYaml(content) as unknown;
    const config = merge(parsed, DEFAULTS);

    return {
      path: resolvedPath,
      baseDir: dirname(resolvedPath),
      source: 'file',
      config,
    };
  }

  const syntheticPath = resolvedPath ?? resolve(DEFAULT_CONFIG_PATHS[0]);
  return {
    path: syntheticPath,
    baseDir: dirname(syntheticPath),
    source: 'defaults',
    config: DEFAULTS,
  };
}

export function toJsonSafeConfig(config: SidecarConfig): SidecarConfig {
  return {
    ...config,
    polymarket: { ...config.polymarket },
    runtime: { ...config.runtime },
    execution: {
      ...config.execution,
      tradeLimits: { ...config.execution.tradeLimits },
      marketAccess: { ...config.execution.marketAccess },
      circuitBreaker: { ...config.execution.circuitBreaker },
    },
    audit: { ...config.audit },
    positions: { ...config.positions },
    mcp: { ...config.mcp },
    veto: {
      ...config.veto,
      cloud: { ...config.veto.cloud },
      multiSig: { ...config.veto.multiSig },
      identity: { ...config.veto.identity },
    },
    economic: {
      ...config.economic,
      approvedPayers: [...config.economic.approvedPayers],
      scopes: [...config.economic.scopes],
      cloud: { ...config.economic.cloud },
    },
    x402: {
      ...config.x402,
      tools: {
        intelSearch: {
          ...config.x402.tools.intelSearch,
          allowedNetworks: [...config.x402.tools.intelSearch.allowedNetworks],
          allowedAssets: [...config.x402.tools.intelSearch.allowedAssets],
        },
        intelMarketContext: {
          ...config.x402.tools.intelMarketContext,
          allowedNetworks: [...config.x402.tools.intelMarketContext.allowedNetworks],
          allowedAssets: [...config.x402.tools.intelMarketContext.allowedAssets],
        },
      },
    },
  };
}
