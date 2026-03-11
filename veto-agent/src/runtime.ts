import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Veto } from 'veto-sdk';
import { parse as parseYaml } from 'yaml';
import { resolvePolymarketBinary, type BinaryResolution } from './binary.js';
import { executePolymarket } from './executor.js';
import { EconomicAuthorizer, type EconomicCloudClient, type EconomicDecision, type EconomicReceipt } from './economic.js';
import { AuditLogger, type AuditEntry } from './audit.js';
import { AgentIdentity } from './agent-identity.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { ComplianceExporter } from './compliance.js';
import { MarketAccessControl } from './market-access.js';
import { MultiSigManager } from './multi-sig.js';
import { PositionTracker } from './position-tracker.js';
import { TradeTracker } from './trade-tracker.js';
import { getToolSpec, listTools, profileAgentId, type ToolSpec } from './tools.js';
import type {
  ApprovalMode,
  DecisionEnvelope,
  ExecutionResult,
  McpToolResult,
  ResolvedConfig,
  RuntimeDecision,
  RuntimeErrorShape,
  ToolResponseEnvelope,
} from './types.js';
import { X402ToolError, X402ToolRuntime, type X402PreflightResult } from './x402.js';

interface GuardClient {
  guard(toolName: string, args: Record<string, unknown>, context: { sessionId: string; agentId: string }): Promise<RuntimeDecision>;
}

interface RuntimeDependencies {
  execute?: (binaryPath: string, argv: string[], opts: { timeoutMs: number; maxOutputBytes: number }) => Promise<ExecutionResult>;
  guard?: GuardClient;
  waitForApproval?: (approvalId: string) => Promise<ApprovalResolution>;
  economicClient?: EconomicCloudClient;
  x402Runtime?: X402ToolRuntime;
}

interface ApprovalResolution {
  status: 'approved' | 'denied' | 'expired';
  resolvedBy?: string;
}

interface ApprovalStatusResponse {
  approvalId: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'unknown';
  resolvedBy?: string;
  source: 'cloud' | 'local';
  healthy: boolean;
  message?: string;
}

interface LiveState {
  simulation: boolean;
  reason?: string;
}

interface ResolvedBinaryState extends BinaryResolution {
  available: boolean;
}

class RuntimeError extends Error {
  readonly shape: RuntimeErrorShape;

  constructor(shape: RuntimeErrorShape) {
    super(shape.message);
    this.shape = shape;
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function extractMidpoint(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return asNumber(row.midpoint) ?? asNumber(row.mid) ?? asNumber(row.price) ?? null;
}

function uniqueReasons(...reasons: Array<string | undefined>): string | undefined {
  const joined = [...new Set(reasons.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
  return joined.length > 0 ? joined.join('; ') : undefined;
}

function economicMessageForUser(decision?: EconomicDecision): string | undefined {
  if (!decision?.message) return undefined;
  if (decision.decision !== 'allow') return decision.message;
  if (decision.reasonCode === 'economic_disabled' || decision.reasonCode === 'economic_authorized') {
    return undefined;
  }
  return decision.message;
}

export class PolymarketVetoRuntime {
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly execute: NonNullable<RuntimeDependencies['execute']>;
  private readonly guard: GuardClient;
  private readonly waitForApproval: NonNullable<RuntimeDependencies['waitForApproval']>;
  private readonly binary: ResolvedBinaryState;
  private readonly economicAuthorizer: EconomicAuthorizer;
  private readonly x402Runtime: X402ToolRuntime;

  private readonly auditLogger: AuditLogger;
  private readonly marketAccess: MarketAccessControl;
  private readonly tradeTracker: TradeTracker;
  private readonly positionTracker: PositionTracker;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly multiSig: MultiSigManager;
  private readonly agentIdentity: AgentIdentity;
  private readonly complianceExporter: ComplianceExporter;

  private constructor(
    private readonly resolved: ResolvedConfig,
    deps: RuntimeDependencies,
  ) {
    this.sessionId = this.resolveSessionId();
    this.agentId = this.resolveAgentId();
    this.execute = deps.execute ?? executePolymarket;
    this.guard = deps.guard as GuardClient;
    this.waitForApproval = deps.waitForApproval ?? ((approvalId) => this.waitForApprovalFromCloud(approvalId));

    if (deps.execute) {
      this.binary = {
        requestedPath: this.resolved.config.polymarket.binaryPath,
        resolvedPath: this.resolved.config.polymarket.binaryPath,
        source: 'injected',
        checkedPaths: [],
        available: true,
      };
    } else {
      const discovered = resolvePolymarketBinary({
        requestedPath: this.resolved.config.polymarket.binaryPath,
        baseDir: this.resolved.baseDir,
      });

      this.binary = {
        ...discovered,
        available: Boolean(discovered.resolvedPath),
      };

      if (discovered.resolvedPath) {
        this.resolved.config.polymarket.binaryPath = discovered.resolvedPath;
      }
    }

    const cfg = this.resolved.config;
    this.auditLogger = new AuditLogger(cfg.audit);
    this.marketAccess = new MarketAccessControl(cfg.execution.marketAccess);
    this.tradeTracker = new TradeTracker();
    this.positionTracker = new PositionTracker(cfg.positions);
    this.circuitBreaker = new CircuitBreaker(cfg.execution.circuitBreaker, this.positionTracker);
    this.multiSig = new MultiSigManager(cfg.veto.multiSig);
    this.agentIdentity = new AgentIdentity(cfg.veto.identity);
    this.complianceExporter = new ComplianceExporter(this.auditLogger);
    this.economicAuthorizer = new EconomicAuthorizer(cfg.economic, deps.economicClient ? { client: deps.economicClient } : {});
    this.x402Runtime = deps.x402Runtime ?? new X402ToolRuntime(cfg.x402);
  }

  static async create(resolved: ResolvedConfig, deps: RuntimeDependencies = {}): Promise<PolymarketVetoRuntime> {
    if (!deps.guard) {
      const vetoConfigDir = resolve(resolved.baseDir, resolved.config.veto.configDir);
      const veto = await Veto.init({
        configDir: vetoConfigDir,
        logLevel: 'silent',
      });

      deps.guard = {
        guard: (toolName, args, context) => veto.guard(toolName, args, context),
      };
    }

    const runtime = new PolymarketVetoRuntime(resolved, deps);
    runtime.positionTracker.load();
    return runtime;
  }

  async status(): Promise<Record<string, unknown>> {
    return await this.getRuntimeStatusReport();
  }

  async getApprovalStatus(approvalId: string): Promise<ApprovalStatusResponse> {
    return await this.lookupApprovalStatus(approvalId);
  }

  getStartupInfo(): Record<string, unknown> {
    return {
      configPath: this.resolved.path,
      configSource: this.resolved.source,
      profile: this.resolved.config.veto.policyProfile,
      agentId: this.agentId,
      sessionId: this.sessionId,
      approvalMode: this.resolved.config.runtime.approvalMode,
      simulationDefault: this.resolved.config.execution.simulationDefault,
      allowLiveTrades: this.resolved.config.execution.allowLiveTrades,
      liveTradingReady: this.isLiveTradingReady(),
      economicEnabled: this.resolved.config.economic.enabled,
      x402Enabled: this.resolved.config.x402.enabled,
      transport: this.resolved.config.mcp.transport,
      host: this.resolved.config.mcp.host,
      port: this.resolved.config.mcp.port,
      path: this.resolved.config.mcp.path,
      binaryPath: this.resolved.config.polymarket.binaryPath,
      binaryRequestedPath: this.binary.requestedPath,
      binaryResolvedPath: this.binary.resolvedPath,
      binarySource: this.binary.source,
      binaryAvailable: this.binary.available,
    };
  }

  listMcpTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
    }));
  }

  private resolveAgentId(): string {
    const envName = this.resolved.config.runtime.agentIdEnv;
    const envValue = optionalString(process.env[envName]);
    if (envValue) return envValue;
    const configured = optionalString(this.resolved.config.runtime.agentId);
    if (configured) return configured;
    return profileAgentId(this.resolved.config.veto.policyProfile);
  }

  private resolveSessionId(): string {
    const envName = this.resolved.config.runtime.sessionIdEnv;
    const envValue = optionalString(process.env[envName]);
    if (envValue) return envValue;
    const configured = optionalString(this.resolved.config.runtime.sessionId);
    if (configured) return configured;
    return `session-${Date.now().toString(36)}`;
  }

  private isLiveTradingReady(): boolean {
    return this.resolved.config.execution.allowLiveTrades
      && (process.env.ALLOW_LIVE_TRADES ?? '').toLowerCase() === 'true';
  }

  private approvalMode(): ApprovalMode {
    return this.resolved.config.runtime.approvalMode;
  }

  private async getRuntimeStatusReport(): Promise<Record<string, unknown>> {
    const warnings: string[] = [];
    const apiKeyEnv = this.resolved.config.economic.cloud.apiKeyEnv;
    const economicApiKeyPresent = Boolean(optionalString(process.env[apiKeyEnv]));
    const x402WalletEnv = this.resolved.config.x402.evmPrivateKeyEnv;
    const x402WalletPresent = Boolean(optionalString(process.env[x402WalletEnv]));
    const liveTradingReady = this.isLiveTradingReady();

    if (!this.binary.available) {
      warnings.push('Polymarket CLI binary is unavailable.');
    }

    if (this.resolved.config.execution.allowLiveTrades && !liveTradingReady) {
      warnings.push('Live trading is enabled in config but ALLOW_LIVE_TRADES=true is not set.');
    }

    if (this.resolved.config.economic.enabled) {
      if (!this.resolved.config.economic.defaultPayer) {
        warnings.push('Economic authorization is enabled without a default payer.');
      }
      if (!economicApiKeyPresent) {
        warnings.push(`Economic authorization is enabled but ${apiKeyEnv} is not set.`);
      }
    }

    if (this.resolved.config.x402.enabled) {
      if (!x402WalletPresent) {
        warnings.push(`x402 is enabled but ${x402WalletEnv} is not set.`);
      }

      for (const [toolKey, service] of Object.entries(this.resolved.config.x402.tools)) {
        if (service.enabled && !optionalString(service.url)) {
          warnings.push(`x402 tool '${toolKey}' is enabled without a service URL.`);
        }
      }
    }

    const budgetStatus = await this.economicAuthorizer.getBudgetStatus({
      sessionId: this.sessionId,
      agentId: this.agentId,
    });

    if (this.resolved.config.economic.enabled && budgetStatus.healthy === false) {
      warnings.push('Economic authority is unhealthy or unreachable.');
    }

    return {
      ok: warnings.length === 0,
      profile: this.resolved.config.veto.policyProfile,
      agentId: this.agentId,
      sessionId: this.sessionId,
      approvalMode: this.approvalMode(),
      runtime: {
        configPath: this.resolved.path,
        transport: this.resolved.config.mcp.transport,
        simulationDefault: this.resolved.config.execution.simulationDefault,
        liveTradesConfigured: this.resolved.config.execution.allowLiveTrades,
        liveTradingReady,
        binaryAvailable: this.binary.available,
        binaryResolvedPath: this.binary.resolvedPath,
      },
      controls: {
        marketAccessEnabled: this.resolved.config.execution.marketAccess.enabled,
        circuitBreakerEnabled: this.resolved.config.execution.circuitBreaker.enabled,
        tradeLimitsEnabled: this.resolved.config.execution.tradeLimits.enabled,
      },
      economic: {
        enabled: this.resolved.config.economic.enabled,
        defaultPayer: this.resolved.config.economic.defaultPayer,
        approvedPayers: this.resolved.config.economic.approvedPayers,
        scopes: this.resolved.config.economic.scopes,
        apiKeyEnv,
        apiKeyPresent: economicApiKeyPresent,
        status: budgetStatus,
      },
      x402: {
        enabled: this.resolved.config.x402.enabled,
        walletEnv: x402WalletEnv,
        walletPresent: x402WalletPresent,
        tools: {
          intelSearch: {
            enabled: this.resolved.config.x402.tools.intelSearch.enabled,
            url: this.resolved.config.x402.tools.intelSearch.url,
            maxPriceUsd: this.resolved.config.x402.tools.intelSearch.maxPriceUsd,
          },
          intelMarketContext: {
            enabled: this.resolved.config.x402.tools.intelMarketContext.enabled,
            url: this.resolved.config.x402.tools.intelMarketContext.url,
            maxPriceUsd: this.resolved.config.x402.tools.intelMarketContext.maxPriceUsd,
          },
        },
      },
      warnings,
    };
  }

  private async lookupApprovalStatus(approvalId: string, strict4xx = false): Promise<ApprovalStatusResponse> {
    const localPending = this.economicAuthorizer.getPendingApprovals().includes(approvalId);
    let config: ReturnType<PolymarketVetoRuntime['readApprovalPollingConfig']>;

    try {
      config = this.readApprovalPollingConfig();
    } catch (error) {
      if (strict4xx && error instanceof RuntimeError) {
        throw error;
      }

      return {
        approvalId,
        status: localPending ? 'pending' : 'unknown',
        source: 'local',
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const url = `${config.baseUrl}/v1/approvals/${encodeURIComponent(approvalId)}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Veto-API-Key': config.apiKey,
        },
      });

      if (response.ok) {
        const body = toRecord(await response.json());
        const status = optionalString(body.status)?.toLowerCase();
        const resolvedBy = optionalString(body.resolvedBy);

        if (status === 'approved' || status === 'denied' || status === 'expired') {
          this.economicAuthorizer.markApprovalResolved(approvalId);
          return {
            approvalId,
            status,
            resolvedBy,
            source: 'cloud',
            healthy: true,
          };
        }

        this.economicAuthorizer.trackPendingApproval(approvalId);
        return {
          approvalId,
          status: 'pending',
          resolvedBy,
          source: 'cloud',
          healthy: true,
        };
      }

      const responseText = await response.text().catch(() => '');
      const message = `Approval lookup failed: status ${response.status}${responseText ? `: ${responseText}` : ''}`;

      if (strict4xx && response.status >= 400 && response.status < 500) {
        throw new RuntimeError({
          code: -32003,
          message: `Approval polling failed: status ${response.status}${responseText ? `: ${responseText}` : ''}`,
          data: { approvalId },
        });
      }

      return {
        approvalId,
        status: localPending ? 'pending' : 'unknown',
        source: localPending ? 'local' : 'cloud',
        healthy: false,
        message,
      };
    } catch (error) {
      if (strict4xx && error instanceof RuntimeError) {
        throw error;
      }

      return {
        approvalId,
        status: localPending ? 'pending' : 'unknown',
        source: 'local',
        healthy: false,
        message: `Approval lookup unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private binaryFixes(): string[] {
    return [
      "Install Polymarket CLI globally (for macOS/Linux: 'brew install polymarket').",
      "Or build this repo binary: 'cargo build --release' and use './target/release/polymarket'.",
      "Or set POLYMARKET_BINARY_PATH to a valid executable.",
      "Or set polymarket.binaryPath in veto-agent/polymarket-veto.config.yaml.",
    ];
  }

  private binaryMissingMessage(): string {
    return [
      'Polymarket CLI binary not found.',
      `requested='${this.binary.requestedPath}'`,
      `checked=${this.binary.checkedPaths.length}`,
      "Run 'polymarket-veto-mcp doctor' for detailed diagnostics.",
    ].join(' ');
  }

  private requireBinaryPath(): string {
    if (this.binary.resolvedPath) {
      return this.binary.resolvedPath;
    }

    throw new RuntimeError({
      code: -32003,
      message: this.binaryMissingMessage(),
      data: {
        requestedPath: this.binary.requestedPath,
        checkedPaths: this.binary.checkedPaths,
        fixes: this.binaryFixes(),
      },
    });
  }

  async doctor(): Promise<Record<string, unknown>> {
    let binaryResult: ExecutionResult | null = null;

    if (this.binary.resolvedPath) {
      binaryResult = await this.execute(
        this.binary.resolvedPath,
        ['--version'],
        {
          timeoutMs: Math.min(this.resolved.config.execution.maxCommandTimeoutMs, 4000),
          maxOutputBytes: this.resolved.config.execution.maxOutputBytes,
        },
      );
    }

    const vetoConfigPath = resolve(this.resolved.baseDir, this.resolved.config.veto.configDir, 'veto.config.yaml');
    const rulesDir = resolve(this.resolved.baseDir, this.resolved.config.veto.configDir, 'rules');
    const binaryOk = binaryResult?.ok === true;

    return {
      ok: binaryOk && existsSync(vetoConfigPath) && existsSync(rulesDir),
      binary: {
        requestedPath: this.binary.requestedPath,
        resolvedPath: this.binary.resolvedPath,
        source: this.binary.source,
        checkedPaths: this.binary.checkedPaths,
        ok: binaryOk,
        exitCode: binaryResult?.exitCode ?? -1,
        stdout: binaryResult?.stdout.trim() ?? '',
        stderr: binaryResult?.stderr.trim() ?? (this.binary.resolvedPath ? '' : this.binaryMissingMessage()),
        fixes: this.binaryFixes(),
      },
      veto: {
        configDir: resolve(this.resolved.baseDir, this.resolved.config.veto.configDir),
        configPath: vetoConfigPath,
        configExists: existsSync(vetoConfigPath),
        rulesDir,
        rulesDirExists: existsSync(rulesDir),
        profile: this.resolved.config.veto.policyProfile,
        agentId: this.agentId,
      },
      economic: {
        enabled: this.resolved.config.economic.enabled,
        x402Enabled: this.resolved.config.x402.enabled,
      },
      runtime: this.getStartupInfo(),
    };
  }

  async callTool(toolName: string, args: Record<string, unknown>, simulationOverride?: boolean): Promise<McpToolResult> {
    const startTime = Date.now();
    const actionId = randomUUID();
    const spec = getToolSpec(toolName);
    if (!spec) {
      throw new RuntimeError({
        code: -32601,
        message: `Unknown tool '${toolName}'`,
      });
    }

    let built;
    try {
      built = spec.build(args);
    } catch (error) {
      throw new RuntimeError({
        code: -32602,
        message: error instanceof Error ? error.message : 'Invalid tool arguments',
      });
    }

    const guardArgs: Record<string, unknown> = {
      ...built.guardArgs,
      timestamp: new Date().toISOString(),
    };

    let x402Preflight: X402PreflightResult | undefined;
    if (spec.execution === 'x402') {
      try {
        x402Preflight = await this.x402Runtime.preflight(toolName, args);
      } catch (error) {
        throw this.mapToolError(error);
      }

      guardArgs.provider = x402Preflight.provider;
      guardArgs.resource_id = x402Preflight.resourceId;
      guardArgs.payer = x402Preflight.payer;
      guardArgs.amount_usd = x402Preflight.quotedSpendUsd;
      guardArgs.network = x402Preflight.network;
      guardArgs.asset = x402Preflight.asset;
    }

    let signature: string | undefined;
    if (this.resolved.config.veto.identity.enabled) {
      try {
        signature = this.agentIdentity.sign(this.agentId, guardArgs);
      } catch {
        // Identity signing failure is non-fatal.
      }
    }

    if (this.resolved.config.execution.marketAccess.enabled && typeof guardArgs.token === 'string') {
      const accessResult = this.marketAccess.check(guardArgs.token);
      if (!accessResult.allowed) {
        this.logAudit(spec, guardArgs, 'deny', accessResult.reason, undefined, startTime, signature);
        throw new RuntimeError({
          code: -32001,
          message: `Blocked by market access: ${accessResult.reason}`,
          data: {
            reasonCode: 'market_access_denied',
          },
        });
      }
    }

    if (this.resolved.config.execution.circuitBreaker.enabled && spec.mutating) {
      const breakerResult = this.circuitBreaker.check();
      if (!breakerResult.allowed) {
        this.logAudit(spec, guardArgs, 'deny', `Circuit breaker: ${breakerResult.trip}`, undefined, startTime, signature);
        throw new RuntimeError({
          code: -32001,
          message: `Blocked by circuit breaker: ${breakerResult.trip}`,
          data: {
            reasonCode: 'circuit_breaker_tripped',
          },
        });
      }
    }

    if (this.resolved.config.execution.tradeLimits.enabled && typeof guardArgs.token === 'string') {
      guardArgs.daily_volume_usd = this.tradeTracker.dailyVolumeUsd(this.agentId);
      guardArgs.position_size_usd = this.tradeTracker.positionSizeUsd(guardArgs.token, this.agentId);
    }

    const liveState = this.resolveLiveState(spec, simulationOverride);
    const policyDecision = await this.guard.guard(toolName, guardArgs, {
      sessionId: this.sessionId,
      agentId: this.agentId,
    });
    const economicDecision = await this.authorizeEconomicAction(spec, toolName, guardArgs, actionId, liveState);
    const decision = this.mergeDecisions(policyDecision, economicDecision);

    if (decision.decision === 'deny') {
      this.logAudit(spec, guardArgs, 'deny', decision.reason, decision.ruleId, startTime, signature, undefined, decision.economic);
      throw new RuntimeError({
        code: -32001,
        message: `Denied by policy: ${decision.reason ?? 'policy violation'}`,
        data: {
          ruleId: decision.ruleId,
          reasonCode: decision.reasonCode,
          approvalId: decision.approvalId,
          budget: decision.economic?.budget,
        },
      });
    }

    const approvalId = await this.ensureApproved(spec, guardArgs, decision, startTime, signature);

    if (spec.execution === 'internal') {
      const result = await this.handleInternalTool(spec.name, args);
      this.logAudit(spec, guardArgs, decision.decision, decision.reason, decision.ruleId, startTime, signature, { ok: true, simulation: false }, decision.economic);
      return result;
    }

    if (spec.execution === 'x402') {
      return await this.executeX402Tool(spec, args, guardArgs, x402Preflight!, liveState, decision, actionId, approvalId, startTime, signature);
    }

    return await this.executePolymarketTool(spec, built, guardArgs, liveState, decision, actionId, approvalId, startTime, signature);
  }

  private async authorizeEconomicAction(
    spec: ToolSpec,
    toolName: string,
    guardArgs: Record<string, unknown>,
    actionId: string,
    liveState: LiveState,
  ): Promise<EconomicDecision | undefined> {
    if (!spec.priced || !spec.economicCategory) return undefined;

    const estimatedSpendUsd = asNumber(guardArgs.amount_usd);
    if (estimatedSpendUsd === null || estimatedSpendUsd <= 0) return undefined;

    const maxAcceptableSpendUsd = toolName === 'intel_search'
      ? this.resolved.config.x402.tools.intelSearch.maxPriceUsd
      : toolName === 'intel_market_context'
        ? this.resolved.config.x402.tools.intelMarketContext.maxPriceUsd
        : undefined;

    return await this.economicAuthorizer.authorize({
      actionId,
      sessionId: this.sessionId,
      agentId: this.agentId,
      toolName,
      category: spec.economicCategory,
      provider: optionalString(guardArgs.provider),
      resourceId: optionalString(guardArgs.resource_id),
      payer: optionalString(guardArgs.payer),
      mode: liveState.simulation ? 'simulation' : 'live',
      estimatedSpendUsd,
      maxAcceptableSpendUsd,
      budgetScopes: this.resolved.config.economic.scopes,
      metadata: { guardArgs },
    });
  }

  private mergeDecisions(policyDecision: RuntimeDecision, economicDecision?: EconomicDecision): DecisionEnvelope {
    if (policyDecision.decision === 'deny') {
      return {
        decision: 'deny',
        reason: policyDecision.reason,
        ruleId: policyDecision.ruleId,
        approvalId: policyDecision.approvalId,
        reasonCode: economicDecision?.reasonCode ?? 'policy_denied',
        economic: economicDecision,
      };
    }

    if (economicDecision?.decision === 'deny') {
      return {
        decision: 'deny',
        reason: economicDecision.message,
        ruleId: policyDecision.ruleId,
        approvalId: economicDecision.approvalId,
        reasonCode: economicDecision.reasonCode,
        economic: economicDecision,
      };
    }

    if (policyDecision.decision === 'require_approval' || economicDecision?.decision === 'require_approval') {
      return {
        decision: 'require_approval',
        reason: uniqueReasons(policyDecision.reason, economicMessageForUser(economicDecision)) ?? 'awaiting approval',
        ruleId: policyDecision.ruleId,
        approvalId: economicDecision?.approvalId ?? policyDecision.approvalId,
        reasonCode: economicDecision?.reasonCode ?? 'approval_required',
        economic: economicDecision,
      };
    }

    return {
      decision: 'allow',
      reason: economicMessageForUser(economicDecision) ?? policyDecision.reason,
      ruleId: policyDecision.ruleId,
      reasonCode: economicDecision?.reasonCode,
      economic: economicDecision,
    };
  }

  private async ensureApproved(
    spec: ToolSpec,
    guardArgs: Record<string, unknown>,
    decision: DecisionEnvelope,
    startTime: number,
    signature: string | undefined,
  ): Promise<string | undefined> {
    if (decision.decision !== 'require_approval') {
      return undefined;
    }

    const approvalId = optionalString(decision.approvalId);
    if (!approvalId) {
      this.logAudit(spec, guardArgs, 'require_approval', decision.reason, decision.ruleId, startTime, signature, undefined, decision.economic);
      throw new RuntimeError({
        code: -32002,
        message: `Approval required: ${decision.reason ?? 'awaiting approval'}`,
        data: {
          ruleId: decision.ruleId,
          reasonCode: decision.reasonCode,
          budget: decision.economic?.budget,
          approvalMode: this.approvalMode(),
          pending: false,
          nextAction: 'enable cloud validation to receive an approvalId',
        },
      });
    }

    this.economicAuthorizer.trackPendingApproval(approvalId);

    if (this.approvalMode() === 'return') {
      this.logAudit(spec, guardArgs, 'require_approval', decision.reason, decision.ruleId, startTime, signature, undefined, decision.economic);
      throw new RuntimeError({
        code: -32002,
        message: `Approval required: ${decision.reason ?? 'awaiting approval'}`,
        data: {
          approvalId,
          ruleId: decision.ruleId,
          reasonCode: decision.reasonCode,
          budget: decision.economic?.budget,
          pending: true,
          approvalMode: this.approvalMode(),
          nextAction: 'approval_status',
        },
      });
    }

    let approval: ApprovalResolution;
    try {
      approval = await this.waitForApproval(approvalId);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError({
        code: -32003,
        message: `Approval polling failed: ${error instanceof Error ? error.message : String(error)}`,
        data: {
          approvalId,
          ruleId: decision.ruleId,
          reasonCode: decision.reasonCode,
        },
      });
    }

    if (approval.status !== 'approved') {
      this.economicAuthorizer.markApprovalResolved(approvalId);
      this.logAudit(spec, guardArgs, 'deny', `Approval ${approval.status}`, decision.ruleId, startTime, signature, undefined, decision.economic);
      throw new RuntimeError({
        code: -32001,
        message: `Denied by policy: Approval ${approval.status}: ${decision.reason ?? 'approval not granted'}`,
        data: {
          approvalId,
          ruleId: decision.ruleId,
          resolvedBy: approval.resolvedBy,
          reasonCode: decision.reasonCode,
          budget: decision.economic?.budget,
        },
      });
    }

    this.economicAuthorizer.markApprovalResolved(approvalId);

    if (this.resolved.config.veto.multiSig.enabled && typeof guardArgs.amount_usd === 'number') {
      if (this.multiSig.needsMultiSig(guardArgs.amount_usd as number)) {
        this.multiSig.recordApproval(approvalId, approval.resolvedBy ?? 'unknown');

        while (!this.multiSig.isFullyApproved(approvalId)) {
          let nextApproval: ApprovalResolution;
          try {
            nextApproval = await this.waitForApproval(approvalId);
          } catch (error) {
            if (error instanceof RuntimeError) throw error;
            throw new RuntimeError({
              code: -32003,
              message: `Multi-sig polling failed: ${error instanceof Error ? error.message : String(error)}`,
              data: { approvalId },
            });
          }

          if (nextApproval.status !== 'approved') {
            throw new RuntimeError({
              code: -32001,
              message: `Multi-sig denied: ${nextApproval.status}`,
              data: {
                approvalId,
                approvalCount: this.multiSig.getApprovalCount(approvalId),
                required: this.multiSig.getRequiredApprovals(),
              },
            });
          }

          this.multiSig.recordApproval(approvalId, nextApproval.resolvedBy ?? 'unknown');
        }
      }
    }

    return approvalId;
  }

  private async executeX402Tool(
    spec: ToolSpec,
    args: Record<string, unknown>,
    guardArgs: Record<string, unknown>,
    preflight: X402PreflightResult,
    liveState: LiveState,
    decision: DecisionEnvelope,
    actionId: string,
    approvalId: string | undefined,
    startTime: number,
    signature: string | undefined,
  ): Promise<McpToolResult> {
    if (liveState.simulation) {
      const payload = {
        live: false,
        tool: spec.name,
        simulation: true,
        reason: liveState.reason,
        output: preflight.preview ?? preflight.freeResponse,
        economic: this.buildPreviewReceipt(spec, guardArgs, decision.economic, approvalId),
      };
      this.logAudit(spec, guardArgs, decision.decision, decision.reason, decision.ruleId, startTime, signature, { ok: true, simulation: true }, decision.economic);
      return {
        content: [{
          type: 'text',
          text: jsonText(payload),
        }],
      };
    }

    let execution;
    try {
      execution = await this.x402Runtime.execute(spec.name, args, preflight);
    } catch (error) {
      throw this.mapToolError(error);
    }

    const receipt = await this.commitEconomicAction(
      spec,
      actionId,
      guardArgs,
      decision.economic,
      approvalId,
      execution.actualSpendUsd,
      execution.provider,
      execution.resourceId,
      execution.payer,
    );

    const payload: ToolResponseEnvelope = {
      live: true,
      tool: spec.name,
      command: execution.command,
      output: execution.paymentResponse
        ? { data: execution.output, paymentResponse: execution.paymentResponse }
        : execution.output,
      economic: receipt,
    };

    this.logAudit(spec, guardArgs, decision.decision, decision.reason, decision.ruleId, startTime, signature, { ok: true, simulation: false }, decision.economic, receipt);
    return {
      content: [{
        type: 'text',
        text: jsonText(payload),
      }],
    };
  }

  private async executePolymarketTool(
    spec: ToolSpec,
    built: { argv: string[]; guardArgs: Record<string, unknown> },
    guardArgs: Record<string, unknown>,
    liveState: LiveState,
    decision: DecisionEnvelope,
    actionId: string,
    approvalId: string | undefined,
    startTime: number,
    signature: string | undefined,
  ): Promise<McpToolResult> {
    const binaryPath = this.requireBinaryPath();

    if (liveState.simulation && spec.mutating) {
      const simulation = await this.simulate(spec, built, binaryPath, liveState.reason);
      simulation.economic = this.buildPreviewReceipt(spec, guardArgs, decision.economic, approvalId);
      this.logAudit(spec, guardArgs, decision.decision, decision.reason, decision.ruleId, startTime, signature, { ok: true, simulation: true }, decision.economic);
      return {
        content: [{
          type: 'text',
          text: jsonText(simulation),
        }],
      };
    }

    const execution = await this.execute(
      binaryPath,
      built.argv,
      {
        timeoutMs: this.resolved.config.execution.maxCommandTimeoutMs,
        maxOutputBytes: this.resolved.config.execution.maxOutputBytes,
      },
    );

    if (!execution.ok) {
      this.logAudit(spec, guardArgs, decision.decision, decision.reason, decision.ruleId, startTime, signature, {
        ok: false,
        exitCode: execution.exitCode,
        simulation: false,
      }, decision.economic);
      throw new RuntimeError({
        code: -32003,
        message: `Command failed: ${execution.stderr || `exit code ${execution.exitCode}`}`,
        data: {
          command: execution.commandPreview,
          exitCode: execution.exitCode,
          stderr: execution.stderr,
        },
      });
    }

    this.recordTradeOutcome(spec, guardArgs);

    const receipt = await this.commitEconomicAction(
      spec,
      actionId,
      guardArgs,
      decision.economic,
      approvalId,
      asNumber(guardArgs.amount_usd) ?? 0,
      optionalString(guardArgs.provider),
      optionalString(guardArgs.resource_id),
      optionalString(guardArgs.payer),
    );

    const payload: ToolResponseEnvelope = {
      live: spec.mutating,
      tool: spec.name,
      command: execution.commandPreview,
      output: execution.parsed,
      economic: receipt,
    };

    this.logAudit(spec, guardArgs, decision.decision, decision.reason, decision.ruleId, startTime, signature, {
      ok: true,
      exitCode: execution.exitCode,
      simulation: false,
    }, decision.economic, receipt);

    return {
      content: [{
        type: 'text',
        text: jsonText(payload),
      }],
    };
  }

  private async commitEconomicAction(
    spec: ToolSpec,
    actionId: string,
    guardArgs: Record<string, unknown>,
    economicDecision: EconomicDecision | undefined,
    approvalId: string | undefined,
    actualSpendUsd: number,
    provider: string | undefined,
    resourceId: string | undefined,
    payer: string | undefined,
  ): Promise<EconomicReceipt | undefined> {
    if (!spec.priced || !spec.economicCategory || actualSpendUsd <= 0) {
      return undefined;
    }

    return await this.economicAuthorizer.commit({
      actionId,
      sessionId: this.sessionId,
      agentId: this.agentId,
      toolName: spec.name,
      category: spec.economicCategory,
      provider,
      resourceId,
      payer,
      quotedSpendUsd: economicDecision?.quotedSpendUsd ?? actualSpendUsd,
      actualSpendUsd,
      approvalId: approvalId ?? economicDecision?.approvalId,
      metadata: { guardArgs },
    });
  }

  private buildPreviewReceipt(
    spec: ToolSpec,
    guardArgs: Record<string, unknown>,
    economicDecision: EconomicDecision | undefined,
    approvalId: string | undefined,
  ): EconomicReceipt | undefined {
    if (!spec.priced || !spec.economicCategory) return undefined;
    return {
      status: 'preview',
      authority: economicDecision?.authority ?? 'disabled',
      category: spec.economicCategory,
      payer: economicDecision?.payer ?? optionalString(guardArgs.payer),
      provider: economicDecision?.provider ?? optionalString(guardArgs.provider),
      resourceId: economicDecision?.resourceId ?? optionalString(guardArgs.resource_id),
      quotedSpendUsd: economicDecision?.quotedSpendUsd ?? asNumber(guardArgs.amount_usd) ?? undefined,
      approvalId: approvalId ?? economicDecision?.approvalId,
      provisional: economicDecision?.provisional,
      reasonCode: economicDecision?.reasonCode,
      message: economicDecision?.message,
      budget: economicDecision?.budget,
    };
  }

  private recordTradeOutcome(spec: ToolSpec, guardArgs: Record<string, unknown>): void {
    if (spec.execution !== 'polymarket' || !spec.mutating || typeof guardArgs.amount_usd !== 'number') {
      return;
    }

    const token = typeof guardArgs.token === 'string' ? guardArgs.token : '';
    const side = (guardArgs.side as 'buy' | 'sell') ?? 'buy';
    const amountUsd = guardArgs.amount_usd as number;

    this.tradeTracker.record({
      timestamp: new Date().toISOString(),
      toolName: spec.name,
      token,
      side,
      amountUsd,
      agentId: this.agentId,
    });

    if (this.resolved.config.positions.enabled) {
      const price = typeof guardArgs.price === 'number' ? guardArgs.price : (amountUsd > 0 ? 1 : 0);
      const shares = typeof guardArgs.size === 'number' ? guardArgs.size : amountUsd;
      this.positionTracker.recordTrade({
        token,
        side,
        shares,
        priceUsd: price,
        amountUsd,
      });
    }

    if (this.resolved.config.execution.circuitBreaker.enabled) {
      this.circuitBreaker.recordOutcome({ pnl: 0, token });
    }
  }

  private async handleInternalTool(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    let result: unknown;

    switch (toolName) {
      case 'audit_query':
        result = this.auditLogger.query({
          since: typeof args.since === 'string' ? args.since : undefined,
          agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
          toolName: typeof args.toolName === 'string' ? args.toolName : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        break;

      case 'pnl_snapshot':
        result = this.positionTracker.getSnapshot();
        break;

      case 'pnl_position': {
        const token = typeof args.token === 'string' ? args.token : '';
        const position = this.positionTracker.getPosition(token);
        result = position ?? { token, message: 'No position found' };
        break;
      }

      case 'circuit_breaker_status':
        result = this.circuitBreaker.getStatus();
        break;

      case 'compliance_report': {
        const format = typeof args.format === 'string' && (args.format === 'csv' || args.format === 'json')
          ? args.format
          : 'json';
        const outputPath = typeof args.outputPath === 'string'
          ? args.outputPath
          : `./data/reports/report-${Date.now()}.${format}`;
        const report = this.complianceExporter.generateReport({
          format: format as 'csv' | 'json',
          period: typeof args.period === 'string' ? args.period as 'day' | 'week' | 'month' : undefined,
          startDate: typeof args.startDate === 'string' ? args.startDate : undefined,
          endDate: typeof args.endDate === 'string' ? args.endDate : undefined,
          outputPath,
        });
        result = report;
        break;
      }

      case 'budget_status':
        result = await this.economicAuthorizer.getBudgetStatus({
          sessionId: this.sessionId,
          agentId: this.agentId,
        });
        break;

      case 'runtime_status':
        result = await this.status();
        break;

      case 'approval_status':
        result = await this.getApprovalStatus(typeof args.approvalId === 'string' ? args.approvalId : '');
        break;

      default:
        result = { error: `Unknown internal tool '${toolName}'` };
    }

    return {
      content: [{
        type: 'text',
        text: jsonText(result),
      }],
    };
  }

  private logAudit(
    spec: ToolSpec,
    guardArgs: Record<string, unknown>,
    decision: string,
    reason: string | undefined,
    ruleId: string | undefined,
    startTime: number,
    signature: string | undefined,
    executionResult?: { ok: boolean; exitCode?: number; simulation: boolean },
    economicDecision?: EconomicDecision,
    economicReceipt?: EconomicReceipt,
  ): void {
    try {
      const entry: AuditEntry = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        agentId: this.agentId,
        toolName: spec.name,
        guardArgs,
        decision,
        reason,
        ruleId,
        executionResult,
        durationMs: Date.now() - startTime,
        economicDecision,
        economicReceipt,
      };

      if (signature) {
        (entry as unknown as Record<string, unknown>)._signature = signature;
        (entry as unknown as Record<string, unknown>)._agentId = this.agentId;
      }

      this.auditLogger.log(entry);
    } catch {
      // Never block trades on audit failure.
    }
  }

  private resolveLiveState(spec: ToolSpec, simulationOverride?: boolean): LiveState {
    if (spec.execution === 'x402') {
      const simulationEnabled = simulationOverride ?? this.resolved.config.execution.simulationDefault;
      return simulationEnabled ? { simulation: true, reason: 'simulation mode enabled' } : { simulation: false };
    }

    if (!spec.mutating) {
      return { simulation: false };
    }

    const simulationEnabled = simulationOverride ?? this.resolved.config.execution.simulationDefault;
    if (simulationEnabled) {
      return { simulation: true, reason: 'simulation mode enabled' };
    }

    if (!this.resolved.config.execution.allowLiveTrades) {
      return { simulation: true, reason: 'live trading disabled in config' };
    }

    if ((process.env.ALLOW_LIVE_TRADES ?? '').toLowerCase() !== 'true') {
      return { simulation: true, reason: 'ALLOW_LIVE_TRADES=true not set' };
    }

    return { simulation: false };
  }

  private readApprovalPollingConfig(): {
    apiKey: string;
    baseUrl: string;
    pollIntervalMs: number;
    timeoutMs: number;
    apiKeyEnv: string;
  } {
    const apiKeyEnv = this.resolved.config.veto.cloud.apiKeyEnv;
    const apiKeyRaw = process.env[apiKeyEnv];
    const apiKey = typeof apiKeyRaw === 'string' ? apiKeyRaw.trim() : '';

    if (!apiKey) {
      throw new RuntimeError({
        code: -32002,
        message: `Approval required but ${apiKeyEnv} is not set for cloud polling`,
      });
    }

    let baseUrl = 'https://api.runveto.com';
    let pollIntervalMs = 2_000;
    let timeoutMs = 300_000;

    const vetoConfigPath = resolve(this.resolved.baseDir, this.resolved.config.veto.configDir, 'veto.config.yaml');

    if (existsSync(vetoConfigPath)) {
      try {
        const parsed = parseYaml(readFileSync(vetoConfigPath, 'utf-8')) as unknown;
        const root = toRecord(parsed);
        const cloud = toRecord(root.cloud);
        const approval = toRecord(root.approval);

        const configuredBaseUrl = optionalString(cloud.baseUrl);
        if (configuredBaseUrl) {
          baseUrl = configuredBaseUrl;
        }

        const configuredPollInterval = optionalPositiveInt(approval.pollInterval);
        if (configuredPollInterval) {
          pollIntervalMs = configuredPollInterval;
        }

        const configuredTimeout = optionalPositiveInt(approval.timeout);
        if (configuredTimeout) {
          timeoutMs = configuredTimeout;
        }
      } catch {
        // fall through to defaults.
      }
    }

    return {
      apiKey,
      baseUrl: baseUrl.replace(/\/$/, ''),
      pollIntervalMs,
      timeoutMs,
      apiKeyEnv,
    };
  }

  private async waitForApprovalFromCloud(approvalId: string): Promise<ApprovalResolution> {
    const config = this.readApprovalPollingConfig();
    const deadline = Date.now() + config.timeoutMs;
    let lastError: string | undefined;

    while (true) {
      try {
        const status = await this.lookupApprovalStatus(approvalId, true);

        if (status.status === 'approved' || status.status === 'denied' || status.status === 'expired') {
          return {
            status: status.status,
            resolvedBy: status.resolvedBy,
          };
        }

        if (status.status === 'unknown') {
          lastError = status.message ?? 'unknown approval status';
        }
      } catch (error) {
        if (error instanceof RuntimeError) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : String(error);
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        if (lastError) {
          throw new RuntimeError({
            code: -32003,
            message: `Approval polling failed: ${lastError}`,
            data: { approvalId },
          });
        }

        throw new RuntimeError({
          code: -32002,
          message: `Approval required but timed out after ${Math.floor(config.timeoutMs / 1000)}s`,
          data: { approvalId },
        });
      }

      await sleep(Math.min(config.pollIntervalMs, remainingMs));
    }
  }

  private async simulate(
    spec: ToolSpec,
    built: { argv: string[]; guardArgs: Record<string, unknown> },
    binaryPath: string,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {
      simulation: true,
      reason,
      tool: spec.name,
      command: `${binaryPath} -o json ${built.argv.join(' ')}`,
      guardArgs: built.guardArgs,
      liveTrading: false,
    };

    if (spec.name === 'order_market' || spec.name === 'order_create_limit') {
      const token = typeof built.guardArgs.token === 'string' ? built.guardArgs.token : null;
      if (token) {
        const midpointResponse = await this.execute(
          binaryPath,
          ['clob', 'midpoint', token],
          {
            timeoutMs: Math.min(this.resolved.config.execution.maxCommandTimeoutMs, 5000),
            maxOutputBytes: this.resolved.config.execution.maxOutputBytes,
          },
        );

        if (midpointResponse.ok) {
          const midpoint = extractMidpoint(midpointResponse.parsed);
          out.marketReference = {
            token,
            midpoint,
            raw: midpointResponse.parsed,
          };

          if (midpoint !== null) {
            this.positionTracker.updateMidpoint(token, midpoint);
          }

          if (spec.name === 'order_market') {
            const amount = asNumber(built.guardArgs.amount);
            if (amount !== null && midpoint !== null && midpoint > 0) {
              out.estimatedShares = Number((amount / midpoint).toFixed(6));
            }
          }

          if (spec.name === 'order_create_limit') {
            const price = asNumber(built.guardArgs.price);
            const size = asNumber(built.guardArgs.size);
            if (price !== null && size !== null) {
              out.estimatedNotionalUsd = Number((price * size).toFixed(6));
            }
            if (price !== null && midpoint !== null) {
              out.priceVsMidpoint = Number((price - midpoint).toFixed(6));
            }
          }
        } else {
          out.marketReference = {
            token,
            warning: midpointResponse.stderr || `midpoint lookup failed with code ${midpointResponse.exitCode}`,
          };
        }
      }
    }

    return out;
  }

  private mapToolError(error: unknown): RuntimeError {
    if (error instanceof RuntimeError) return error;
    if (error instanceof X402ToolError) {
      const code = error.reasonCode === 'price_above_cap' ? -32001 : -32003;
      return new RuntimeError({
        code,
        message: error.message,
        data: {
          reasonCode: error.reasonCode,
        },
      });
    }
    return new RuntimeError({
      code: -32003,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  toRpcError(error: unknown): RuntimeErrorShape {
    if (error instanceof RuntimeError) {
      return error.shape;
    }

    if (error instanceof Error) {
      return {
        code: -32603,
        message: error.message,
      };
    }

    return {
      code: -32603,
      message: 'Unknown runtime error',
      data: { error },
    };
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
