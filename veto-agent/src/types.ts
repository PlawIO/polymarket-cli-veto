import type { AuditConfig } from './audit.js';
import type { CircuitBreakerConfig } from './circuit-breaker.js';
import type { MarketAccessConfig } from './market-access.js';
import type { MultiSigConfig } from './multi-sig.js';
import type { PositionTrackerConfig } from './position-tracker.js';
import type { TradeLimitsConfig } from './trade-tracker.js';
import type { IdentityConfig } from './agent-identity.js';

export type { AuditConfig } from './audit.js';
export type { CircuitBreakerConfig } from './circuit-breaker.js';
export type { MarketAccessConfig } from './market-access.js';
export type { MultiSigConfig } from './multi-sig.js';
export type { PositionTrackerConfig } from './position-tracker.js';
export type { TradeLimitsConfig } from './trade-tracker.js';
export type { IdentityConfig } from './agent-identity.js';

export const POLICY_PROFILES = ['defaults', 'conservative', 'agent', 'user'] as const;
export type PolicyProfile = (typeof POLICY_PROFILES)[number];
export type McpTransport = 'stdio' | 'sse';

export interface SidecarConfig {
  polymarket: {
    binaryPath: string;
  };
  execution: {
    simulationDefault: boolean;
    allowLiveTrades: boolean;
    maxCommandTimeoutMs: number;
    maxOutputBytes: number;
    tradeLimits: TradeLimitsConfig;
    marketAccess: MarketAccessConfig;
    circuitBreaker: CircuitBreakerConfig;
  };
  audit: AuditConfig;
  positions: PositionTrackerConfig;
  mcp: {
    transport: McpTransport;
    host: string;
    port: number;
    path: string;
  };
  veto: {
    configDir: string;
    policyProfile: PolicyProfile;
    cloud: {
      apiKeyEnv: string;
    };
    multiSig: MultiSigConfig;
    identity: IdentityConfig;
  };
}

export interface ResolvedConfig {
  path: string;
  baseDir: string;
  source: 'file' | 'defaults';
  config: SidecarConfig;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ExecutionResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed: unknown;
  argv: string[];
  commandPreview: string;
}

export interface RuntimeDecision {
  decision: 'allow' | 'deny' | 'require_approval';
  reason?: string;
  ruleId?: string;
  approvalId?: string;
}

export interface RuntimeErrorShape {
  code: number;
  message: string;
  data?: unknown;
}
