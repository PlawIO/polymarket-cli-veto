import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PolymarketVetoRuntime } from '../src/runtime.js';
import type { ExecutionResult, ResolvedConfig, RuntimeDecision } from '../src/types.js';

function makeConfig(): ResolvedConfig {
  return {
    path: '/tmp/polymarket-veto.config.yaml',
    baseDir: process.cwd(),
    source: 'defaults',
    config: {
      polymarket: {
        binaryPath: 'polymarket',
      },
      execution: {
        simulationDefault: true,
        allowLiveTrades: false,
        maxCommandTimeoutMs: 10_000,
        maxOutputBytes: 1_048_576,
        tradeLimits: {
          enabled: false,
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
        enabled: false,
        filePath: './data/audit.jsonl',
        maxFileSizeMb: 50,
      },
      positions: {
        enabled: false,
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
    },
  };
}

function okExecution(argv: string[], parsed: unknown): ExecutionResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: JSON.stringify(parsed),
    stderr: '',
    parsed,
    argv,
    commandPreview: `polymarket -o json ${argv.join(' ')}`,
  };
}

describe('MCP tool boundary — wallet ops rejected at registry', () => {
  const EXCLUDED_TOOLS = ['wallet_import', 'wallet_reset', 'clob_delete_api_key'] as const;

  for (const tool of EXCLUDED_TOOLS) {
    it(`rejects ${tool} as unknown tool without invoking guard`, async () => {
      const guardFn = vi.fn();
      const runtime = await PolymarketVetoRuntime.create(makeConfig(), {
        guard: { guard: guardFn },
        execute: async (binary, argv) => okExecution(argv, { ok: true }),
      });

      let error: unknown;
      try {
        await runtime.callTool(tool, {});
      } catch (err) {
        error = err;
      }

      const mapped = runtime.toRpcError(error);
      expect(mapped.code).toBe(-32601);
      expect(mapped.message).toContain('Unknown tool');
      expect(guardFn).not.toHaveBeenCalled();
    });
  }
});

describe('runtime decisions', () => {
  it('maps deny decisions to policy error code', async () => {
    const runtime = await PolymarketVetoRuntime.create(makeConfig(), {
      guard: {
        async guard(): Promise<RuntimeDecision> {
          return { decision: 'deny', reason: 'budget exceeded' };
        },
      },
      execute: async (binary, argv) => okExecution(argv, { ok: true }),
    });

    let error: unknown;
    try {
      await runtime.callTool('order_market', { token: '1', side: 'buy', amount: 10 });
    } catch (err) {
      error = err;
    }

    const mapped = runtime.toRpcError(error);
    expect(mapped.code).toBe(-32001);
    expect(mapped.message).toContain('Denied by policy');
  });

  it('maps approval decisions to approval-required code', async () => {
    const runtime = await PolymarketVetoRuntime.create(makeConfig(), {
      guard: {
        async guard(): Promise<RuntimeDecision> {
          return { decision: 'require_approval', reason: 'high amount' };
        },
      },
      execute: async (binary, argv) => okExecution(argv, { ok: true }),
    });

    let error: unknown;
    try {
      await runtime.callTool('order_market', { token: '1', side: 'buy', amount: 10 });
    } catch (err) {
      error = err;
    }

    const mapped = runtime.toRpcError(error);
    expect(mapped.code).toBe(-32002);
    expect(mapped.message).toContain('Approval required');
  });

  it('waits for approval and executes tool call when approved', async () => {
    let approvalLookupId: string | null = null;

    const runtime = await PolymarketVetoRuntime.create(makeConfig(), {
      guard: {
        async guard(): Promise<RuntimeDecision> {
          return {
            decision: 'require_approval',
            reason: 'amount requires review',
            approvalId: 'apr_test_123',
          };
        },
      },
      waitForApproval: async (approvalId) => {
        approvalLookupId = approvalId;
        return { status: 'approved', resolvedBy: 'tester' };
      },
      execute: async (binary, argv) => okExecution(argv, { markets: [] }),
    });

    const result = await runtime.callTool('markets_list', { limit: 5, active: true });
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(approvalLookupId).toBe('apr_test_123');
    expect(payload.output).toEqual({ markets: [] });
  });

  it('maps denied approvals to policy error code', async () => {
    const runtime = await PolymarketVetoRuntime.create(makeConfig(), {
      guard: {
        async guard(): Promise<RuntimeDecision> {
          return {
            decision: 'require_approval',
            reason: 'amount requires review',
            approvalId: 'apr_test_456',
          };
        },
      },
      waitForApproval: async () => ({ status: 'denied', resolvedBy: 'reviewer' }),
      execute: async (binary, argv) => okExecution(argv, { ok: true }),
    });

    let error: unknown;
    try {
      await runtime.callTool('markets_list', { limit: 5, active: true });
    } catch (err) {
      error = err;
    }

    const mapped = runtime.toRpcError(error);
    expect(mapped.code).toBe(-32001);
    expect(mapped.message).toContain('Denied by policy');
    expect(mapped.message).toContain('Approval denied');
  });

  it('simulates mutating commands and computes notional/estimates', async () => {
    const calls: string[][] = [];

    const runtime = await PolymarketVetoRuntime.create(makeConfig(), {
      guard: {
        async guard(): Promise<RuntimeDecision> {
          return { decision: 'allow' };
        },
      },
      execute: async (binary, argv) => {
        calls.push(argv);
        if (argv[0] === 'clob' && argv[1] === 'midpoint') {
          return okExecution(argv, { midpoint: 0.5 });
        }
        return okExecution(argv, { ok: true });
      },
    });

    const result = await runtime.callTool('order_market', {
      token: '1',
      side: 'buy',
      amount: 20,
    });

    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload.simulation).toBe(true);
    expect(payload.estimatedShares).toBe(40);

    // midpoint lookup should happen, live command should not execute.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['clob', 'midpoint', '1']);
  });

  it('fails fast on non-retryable approval polling 4xx responses', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'polymarket-veto-'));
    const vetoDir = join(tempDir, 'veto');
    mkdirSync(vetoDir, { recursive: true });
    writeFileSync(
      join(vetoDir, 'veto.config.yaml'),
      [
        'validation:',
        '  mode: cloud',
        'cloud:',
        '  baseUrl: https://api.runveto.com',
        'approval:',
        '  pollInterval: 10',
        '  timeout: 1000',
        '',
      ].join('\n'),
      'utf-8',
    );

    const prevApiKey = process.env.VETO_API_KEY;
    process.env.VETO_API_KEY = 'veto_test_key';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'access_denied' } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const cfg = makeConfig();
    const runtime = await PolymarketVetoRuntime.create(
      {
        ...cfg,
        baseDir: tempDir,
        config: {
          ...cfg.config,
          veto: {
            ...cfg.config.veto,
            configDir: 'veto',
          },
        },
      },
      {
        guard: {
          async guard(): Promise<RuntimeDecision> {
            return {
              decision: 'require_approval',
              reason: 'needs review',
              approvalId: 'apr_non_retryable_403',
            };
          },
        },
        execute: async (binary, argv) => okExecution(argv, { ok: true }),
      },
    );

    let error: unknown;
    try {
      await runtime.callTool('markets_list', { limit: 1, active: true });
    } catch (err) {
      error = err;
    } finally {
      if (prevApiKey === undefined) {
        delete process.env.VETO_API_KEY;
      } else {
        process.env.VETO_API_KEY = prevApiKey;
      }
      vi.unstubAllGlobals();
      rmSync(tempDir, { recursive: true, force: true });
    }

    const mapped = runtime.toRpcError(error);
    expect(mapped.code).toBe(-32003);
    expect(mapped.message).toContain('Approval polling failed: status 403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
