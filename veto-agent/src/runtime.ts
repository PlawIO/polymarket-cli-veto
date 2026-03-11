import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Veto } from 'veto-sdk';
import { parse as parseYaml } from 'yaml';
import { resolvePolymarketBinary, type BinaryResolution } from './binary.js';
import { executePolymarket } from './executor.js';
import { getToolSpec, listTools, profileAgentId, type ToolSpec } from './tools.js';
import type {
  ExecutionResult,
  McpToolResult,
  ResolvedConfig,
  RuntimeDecision,
  RuntimeErrorShape,
} from './types.js';
import { AuditLogger, type AuditEntry } from './audit.js';
import { MarketAccessControl } from './market-access.js';
import { TradeTracker } from './trade-tracker.js';
import { PositionTracker } from './position-tracker.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { MultiSigManager } from './multi-sig.js';
import { AgentIdentity } from './agent-identity.js';
import { ComplianceExporter } from './compliance.js';

interface GuardClient {
  guard(toolName: string, args: Record<string, unknown>, context: { sessionId: string; agentId: string }): Promise<RuntimeDecision>;
}

interface RuntimeDependencies {
  execute?: (binaryPath: string, argv: string[], opts: { timeoutMs: number; maxOutputBytes: number }) => Promise<ExecutionResult>;
  guard?: GuardClient;
  waitForApproval?: (approvalId: string) => Promise<ApprovalResolution>;
}

interface ApprovalResolution {
  status: 'approved' | 'denied' | 'expired';
  resolvedBy?: string;
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

function extractMidpoint(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return asNumber(row.midpoint) ?? asNumber(row.mid) ?? asNumber(row.price) ?? null;
}

export class PolymarketVetoRuntime {
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly execute: NonNullable<RuntimeDependencies['execute']>;
  private readonly guard: GuardClient;
  private readonly waitForApproval: NonNullable<RuntimeDependencies['waitForApproval']>;
  private readonly binary: ResolvedBinaryState;

  // Safety features
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
    this.sessionId = `session-${Date.now().toString(36)}`;
    this.agentId = profileAgentId(this.resolved.config.veto.policyProfile);
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

    // Initialize safety features
    const cfg = this.resolved.config;
    this.auditLogger = new AuditLogger(cfg.audit);
    this.marketAccess = new MarketAccessControl(cfg.execution.marketAccess);
    this.tradeTracker = new TradeTracker();
    this.positionTracker = new PositionTracker(cfg.positions);
    this.circuitBreaker = new CircuitBreaker(cfg.execution.circuitBreaker, this.positionTracker);
    this.multiSig = new MultiSigManager(cfg.veto.multiSig);
    this.agentIdentity = new AgentIdentity(cfg.veto.identity);
    this.complianceExporter = new ComplianceExporter(this.auditLogger);
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

  getStartupInfo(): Record<string, unknown> {
    return {
      configPath: this.resolved.path,
      configSource: this.resolved.source,
      profile: this.resolved.config.veto.policyProfile,
      agentId: this.agentId,
      simulationDefault: this.resolved.config.execution.simulationDefault,
      allowLiveTrades: this.resolved.config.execution.allowLiveTrades,
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
      runtime: this.getStartupInfo(),
    };
  }

  async callTool(toolName: string, args: Record<string, unknown>, simulationOverride?: boolean): Promise<McpToolResult> {
    const startTime = Date.now();
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

    // Feature 7: Agent identity — HMAC sign for audit trail
    let signature: string | undefined;
    if (this.resolved.config.veto.identity.enabled) {
      try {
        signature = this.agentIdentity.sign(this.agentId, guardArgs);
      } catch {
        // Identity signing failure is non-fatal
      }
    }

    // Feature 5: Market access — check token allow/blocklist
    if (this.resolved.config.execution.marketAccess.enabled && typeof guardArgs.token === 'string') {
      const accessResult = this.marketAccess.check(guardArgs.token);
      if (!accessResult.allowed) {
        this.logAudit(spec, guardArgs, 'deny', accessResult.reason, undefined, startTime, signature);
        throw new RuntimeError({
          code: -32001,
          message: `Blocked by market access: ${accessResult.reason}`,
        });
      }
    }

    // Feature 1: Trade limits — check daily volume + position size
    if (this.resolved.config.execution.tradeLimits.enabled && spec.mutating && typeof guardArgs.amount_usd === 'number') {
      const limitResult = this.tradeTracker.checkLimits(
        {
          token: typeof guardArgs.token === 'string' ? guardArgs.token : '',
          amountUsd: guardArgs.amount_usd as number,
          agentId: this.agentId,
          side: (guardArgs.side as 'buy' | 'sell') ?? 'buy',
        },
        this.resolved.config.execution.tradeLimits,
      );
      if (!limitResult.allowed) {
        this.logAudit(spec, guardArgs, 'deny', limitResult.reason, undefined, startTime, signature);
        throw new RuntimeError({
          code: -32001,
          message: `Blocked by trade limits: ${limitResult.reason}`,
        });
      }
    }

    // Feature 4: Circuit breaker — check if tripped
    if (this.resolved.config.execution.circuitBreaker.enabled && spec.mutating) {
      const breakerResult = this.circuitBreaker.check();
      if (!breakerResult.allowed) {
        this.logAudit(spec, guardArgs, 'deny', `Circuit breaker: ${breakerResult.trip}`, undefined, startTime, signature);
        throw new RuntimeError({
          code: -32001,
          message: `Blocked by circuit breaker: ${breakerResult.trip}`,
        });
      }
    }

    // Enrich guardArgs with computed fields for YAML rule evaluation
    if (this.resolved.config.execution.tradeLimits.enabled && typeof guardArgs.token === 'string') {
      guardArgs.daily_volume_usd = this.tradeTracker.dailyVolumeUsd(this.agentId);
      guardArgs.position_size_usd = this.tradeTracker.positionSizeUsd(guardArgs.token, this.agentId);
    }

    // Internal tool handling — bypass binary execution
    if (spec.internal) {
      const result = this.handleInternalTool(spec.name, args);
      this.logAudit(spec, guardArgs, 'allow', undefined, undefined, startTime, signature, { ok: true, simulation: false });
      return result;
    }

    const decision = await this.guard.guard(toolName, guardArgs, {
      sessionId: this.sessionId,
      agentId: this.agentId,
    });

    if (decision.decision === 'deny') {
      this.logAudit(spec, guardArgs, 'deny', decision.reason, decision.ruleId, startTime, signature);
      throw new RuntimeError({
        code: -32001,
        message: `Denied by policy: ${decision.reason ?? 'policy violation'}`,
        data: {
          ruleId: decision.ruleId,
        },
      });
    }

    if (decision.decision === 'require_approval') {
      const approvalId = typeof decision.approvalId === 'string' && decision.approvalId.trim().length > 0
        ? decision.approvalId
        : undefined;

      if (!approvalId) {
        this.logAudit(spec, guardArgs, 'require_approval', decision.reason, decision.ruleId, startTime, signature);
        throw new RuntimeError({
          code: -32002,
          message: `Approval required: ${decision.reason ?? 'awaiting approval'}`,
          data: {
            ruleId: decision.ruleId,
          },
        });
      }

      let approval: ApprovalResolution;
      try {
        approval = await this.waitForApproval(approvalId);
      } catch (error) {
        if (error instanceof RuntimeError) {
          throw error;
        }

        throw new RuntimeError({
          code: -32003,
          message: `Approval polling failed: ${error instanceof Error ? error.message : String(error)}`,
          data: {
            ruleId: decision.ruleId,
            approvalId,
          },
        });
      }

      if (approval.status !== 'approved') {
        this.logAudit(spec, guardArgs, 'deny', `Approval ${approval.status}`, decision.ruleId, startTime, signature);
        throw new RuntimeError({
          code: -32001,
          message: `Denied by policy: Approval ${approval.status}: ${decision.reason ?? 'approval not granted'}`,
          data: {
            ruleId: decision.ruleId,
            approvalId,
            resolvedBy: approval.resolvedBy,
          },
        });
      }

      // Feature 2: Multi-sig — poll for N approvals if needed
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
              this.logAudit(spec, guardArgs, 'deny', `Multi-sig: approval ${nextApproval.status}`, decision.ruleId, startTime, signature);
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
    }

    const binaryPath = this.requireBinaryPath();
    const liveState = this.resolveLiveState(spec, simulationOverride);

    if (spec.mutating && liveState.simulation) {
      const simulation = await this.simulate(spec, built, binaryPath, liveState.reason);

      this.logAudit(spec, guardArgs, decision.decision, decision.reason, decision.ruleId, startTime, signature, { ok: true, simulation: true });
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
      });
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

    // Record trade in trackers (Features 1, 6)
    if (spec.mutating && typeof guardArgs.amount_usd === 'number') {
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

      // Feature 4: Record outcome in circuit breaker
      if (this.resolved.config.execution.circuitBreaker.enabled) {
        this.circuitBreaker.recordOutcome({ pnl: 0, token });
      }
    }

    this.logAudit(spec, guardArgs, decision.decision, decision.reason, decision.ruleId, startTime, signature, {
      ok: true,
      exitCode: execution.exitCode,
      simulation: false,
    });

    return {
      content: [{
        type: 'text',
        text: jsonText({
          live: spec.mutating,
          tool: spec.name,
          command: execution.commandPreview,
          output: execution.parsed,
        }),
      }],
    };
  }

  private handleInternalTool(toolName: string, args: Record<string, unknown>): McpToolResult {
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
      };

      if (signature) {
        (entry as unknown as Record<string, unknown>)._signature = signature;
        (entry as unknown as Record<string, unknown>)._agentId = this.agentId;
      }

      this.auditLogger.log(entry);
    } catch {
      // Never block trades on audit failure
    }
  }

  private resolveLiveState(spec: ToolSpec, simulationOverride?: boolean): LiveState {
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
        // fall through to defaults
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
    const url = `${config.baseUrl}/v1/approvals/${encodeURIComponent(approvalId)}`;
    let lastError: string | undefined;

    while (true) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'X-Veto-API-Key': config.apiKey,
          },
        });

        if (response.ok) {
          const body = toRecord(await response.json());
          const status = optionalString(body.status);

          if (status === 'approved' || status === 'denied' || status === 'expired') {
            return {
              status,
              resolvedBy: optionalString(body.resolvedBy),
            };
          }
        } else if (response.status >= 400 && response.status < 500) {
          const responseText = await response.text().catch(() => '');
          throw new RuntimeError({
            code: -32003,
            message: `Approval polling failed: status ${response.status}${responseText ? `: ${responseText}` : ''}`,
            data: { approvalId },
          });
        } else {
          const responseText = await response.text().catch(() => '');
          lastError = `status ${response.status}${responseText ? `: ${responseText}` : ''}`;
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

          // Update position tracker midpoint
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
