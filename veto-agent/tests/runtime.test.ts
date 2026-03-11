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
      runtime: {
        agentIdEnv: 'VETO_AGENT_ID',
        sessionIdEnv: 'VETO_SESSION_ID',
        approvalMode: 'wait',
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
      economic: {
        enabled: false,
        approvedPayers: [],
        scopes: ['session', 'agent', 'category'],
        cloud: {
          baseUrl: 'https://api.runveto.com',
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
            payer: 'research-wallet',
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
            payer: 'research-wallet',
            queryParam: 'q',
            marketParam: 'market',
            eventParam: 'event',
            tokenParam: 'token',
            allowedNetworks: ['eip155:8453'],
            allowedAssets: ['USDC'],
          },
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
    expect(mapped.message).not.toContain('Economic authorization disabled');
    expect(mapped.data).toMatchObject({
      approvalMode: 'wait',
      pending: false,
    });
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

  it('returns pending approval immediately in async mode', async () => {
    const waitForApproval = vi.fn();

    const runtime = await PolymarketVetoRuntime.create(
      {
        ...makeConfig(),
        config: {
          ...makeConfig().config,
          runtime: {
            ...makeConfig().config.runtime,
            approvalMode: 'return',
          },
        },
      },
      {
        guard: {
          async guard(): Promise<RuntimeDecision> {
            return {
              decision: 'require_approval',
              reason: 'amount requires review',
              approvalId: 'apr_async_123',
            };
          },
        },
        waitForApproval,
        execute: async (binary, argv) => okExecution(argv, { ok: true }),
      },
    );

    let error: unknown;
    try {
      await runtime.callTool('order_market', { token: '1', side: 'buy', amount: 10 });
    } catch (err) {
      error = err;
    }

    const mapped = runtime.toRpcError(error);
    expect(mapped.code).toBe(-32002);
    expect(mapped.message).toContain('Approval required');
    expect(mapped.data).toMatchObject({
      approvalId: 'apr_async_123',
      pending: true,
      approvalMode: 'return',
      nextAction: 'approval_status',
    });
    expect(waitForApproval).not.toHaveBeenCalled();
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

  it('returns budget status from the economic authority', async () => {
    const status = {
      enabled: true,
      authority: 'cloud' as const,
      healthy: true,
      pendingApprovals: ['apr_budget_1'],
      budget: {
        currency: 'USD',
        asOf: '2026-03-11T12:00:00.000Z',
        source: 'cloud' as const,
        session: { remainingUsd: 90, spentUsd: 10, limitUsd: 100 },
      },
    };

    const runtime = await PolymarketVetoRuntime.create(
      {
        ...makeConfig(),
        config: {
          ...makeConfig().config,
          economic: {
            ...makeConfig().config.economic,
            enabled: true,
            defaultPayer: 'ops-wallet',
          },
        },
      },
      {
        guard: {
          async guard(): Promise<RuntimeDecision> {
            return { decision: 'allow' };
          },
        },
        economicClient: {
          authorize: vi.fn(),
          commit: vi.fn(),
          status: vi.fn().mockResolvedValue(status),
        },
        execute: async (binary, argv) => okExecution(argv, { ok: true }),
      },
    );

    const result = await runtime.callTool('budget_status', {});
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(payload.enabled).toBe(true);
    expect(payload.healthy).toBe(true);
    expect(payload.pendingApprovals).toEqual(['apr_budget_1']);
    expect(payload.budget).toMatchObject({
      currency: 'USD',
      session: { remainingUsd: 90 },
    });
  });

  it('reports runtime status with resolved identity and budget health', async () => {
    const prevAgentId = process.env.VETO_AGENT_ID;
    const prevSessionId = process.env.VETO_SESSION_ID;
    process.env.VETO_AGENT_ID = 'env-agent';
    process.env.VETO_SESSION_ID = 'env-session';

    const status = {
      enabled: true,
      authority: 'cloud' as const,
      healthy: true,
      pendingApprovals: ['apr_budget_1'],
      budget: {
        currency: 'USD',
        asOf: '2026-03-11T12:00:00.000Z',
        source: 'cloud' as const,
        session: { remainingUsd: 90, spentUsd: 10, limitUsd: 100 },
      },
    };
    const economicStatus = vi.fn().mockResolvedValue(status);

    try {
      const runtime = await PolymarketVetoRuntime.create(
        {
          ...makeConfig(),
          config: {
            ...makeConfig().config,
            runtime: {
              ...makeConfig().config.runtime,
              agentId: 'config-agent',
              sessionId: 'config-session',
              approvalMode: 'return',
            },
            economic: {
              ...makeConfig().config.economic,
              enabled: true,
              defaultPayer: 'ops-wallet',
            },
          },
        },
        {
          guard: {
            async guard(): Promise<RuntimeDecision> {
              return { decision: 'allow' };
            },
          },
          economicClient: {
            authorize: vi.fn(),
            commit: vi.fn(),
            status: economicStatus,
          },
          execute: async (binary, argv) => okExecution(argv, { ok: true }),
        },
      );

      const result = await runtime.callTool('runtime_status', {});
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

      expect(payload.agentId).toBe('env-agent');
      expect(payload.sessionId).toBe('env-session');
      expect(payload.approvalMode).toBe('return');
      expect((payload.economic as Record<string, unknown>).status).toMatchObject({
        healthy: true,
        pendingApprovals: ['apr_budget_1'],
      });
      expect(economicStatus).toHaveBeenCalledWith({
        sessionId: 'env-session',
        agentId: 'env-agent',
      });
    } finally {
      if (prevAgentId === undefined) {
        delete process.env.VETO_AGENT_ID;
      } else {
        process.env.VETO_AGENT_ID = prevAgentId;
      }

      if (prevSessionId === undefined) {
        delete process.env.VETO_SESSION_ID;
      } else {
        process.env.VETO_SESSION_ID = prevSessionId;
      }
    }
  });

  it('denies priced actions when economic auth requires a payer', async () => {
    const runtime = await PolymarketVetoRuntime.create(
      {
        ...makeConfig(),
        config: {
          ...makeConfig().config,
          execution: {
            ...makeConfig().config.execution,
            simulationDefault: false,
          },
          economic: {
            ...makeConfig().config.economic,
            enabled: true,
          },
        },
      },
      {
        guard: {
          async guard(): Promise<RuntimeDecision> {
            return { decision: 'allow' };
          },
        },
        execute: async (binary, argv) => okExecution(argv, { ok: true }),
      },
    );

    let error: unknown;
    try {
      await runtime.callTool('order_market', { token: '1', side: 'buy', amount: 10 });
    } catch (err) {
      error = err;
    }

    const mapped = runtime.toRpcError(error);
    expect(mapped.code).toBe(-32001);
    expect(mapped.message).toContain('Denied by policy');
    expect(mapped.data).toMatchObject({
      reasonCode: 'payer_missing',
    });
  });

  it('simulates x402 research tools and returns an economic preview', async () => {
    const preflight = vi.fn().mockResolvedValue({
      provider: 'intel-search',
      resourceId: 'intel_search:https://intel.example/search',
      payer: 'research-wallet',
      quotedSpendUsd: 0.03,
      network: 'eip155:8453',
      asset: 'USDC',
      preview: {
        items: [{ title: 'Fed odds drift lower' }],
      },
    });
    const execute = vi.fn();

    const runtime = await PolymarketVetoRuntime.create(
      {
        ...makeConfig(),
        config: {
          ...makeConfig().config,
          x402: {
            ...makeConfig().config.x402,
            enabled: true,
            tools: {
              ...makeConfig().config.x402.tools,
              intelSearch: {
                ...makeConfig().config.x402.tools.intelSearch,
                enabled: true,
                url: 'https://intel.example/search',
              },
            },
          },
        },
      },
      {
        guard: {
          async guard(): Promise<RuntimeDecision> {
            return { decision: 'allow' };
          },
        },
        x402Runtime: {
          preflight,
          execute,
          getService: vi.fn(),
        } as never,
        execute: async (binary, argv) => okExecution(argv, { ok: true }),
      },
    );

    const result = await runtime.callTool('intel_search', { query: 'fed odds', limit: 1 });
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(payload.simulation).toBe(true);
    expect(payload.output).toEqual({
      items: [{ title: 'Fed odds drift lower' }],
    });
    expect(payload.economic).toMatchObject({
      status: 'preview',
      category: 'x402_research',
      payer: 'research-wallet',
      quotedSpendUsd: 0.03,
    });
  });

  it('looks up approval status and clears locally tracked approvals when resolved', async () => {
    const prevApiKey = process.env.VETO_API_KEY;
    process.env.VETO_API_KEY = 'veto_test_key';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'approved', resolvedBy: 'reviewer-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      const runtime = await PolymarketVetoRuntime.create(
        {
          ...makeConfig(),
          config: {
            ...makeConfig().config,
            runtime: {
              ...makeConfig().config.runtime,
              approvalMode: 'return',
            },
          },
        },
        {
          guard: {
            async guard(toolName): Promise<RuntimeDecision> {
              if (toolName === 'order_market') {
                return {
                  decision: 'require_approval',
                  reason: 'needs review',
                  approvalId: 'apr_lookup_1',
                };
              }
              return { decision: 'allow' };
            },
          },
          execute: async (binary, argv) => okExecution(argv, { ok: true }),
        },
      );

      await expect(runtime.callTool('order_market', { token: '1', side: 'buy', amount: 10 })).rejects.toBeDefined();

      const approvalResult = await runtime.callTool('approval_status', { approvalId: 'apr_lookup_1' });
      const approvalPayload = JSON.parse(approvalResult.content[0]!.text) as Record<string, unknown>;
      expect(approvalPayload).toMatchObject({
        approvalId: 'apr_lookup_1',
        status: 'approved',
        resolvedBy: 'reviewer-1',
        source: 'cloud',
        healthy: true,
      });

      const budgetResult = await runtime.callTool('budget_status', {});
      const budgetPayload = JSON.parse(budgetResult.content[0]!.text) as Record<string, unknown>;
      expect(budgetPayload.pendingApprovals).toEqual([]);
    } finally {
      if (prevApiKey === undefined) {
        delete process.env.VETO_API_KEY;
      } else {
        process.env.VETO_API_KEY = prevApiKey;
      }
      vi.unstubAllGlobals();
    }
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
