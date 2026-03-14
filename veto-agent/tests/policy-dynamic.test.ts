import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolicyManager } from '../src/policy-manager.js';
import { PolymarketVetoRuntime } from '../src/runtime.js';
import type {
  EconomicBudgetStatus,
  EconomicCloudClient,
} from '../src/economic.js';
import type {
  ResolvedConfig,
  RuntimeDecision,
} from '../src/types.js';

function makeConfig(baseDir: string): ResolvedConfig {
  return {
    path: join(baseDir, 'polymarket-veto.config.yaml'),
    baseDir,
    source: 'file',
    config: {
      polymarket: {
        binaryPath: 'polymarket',
      },
      runtime: {
        agentId: 'agent-test',
        agentIdEnv: 'VETO_AGENT_ID',
        sessionId: 'session-test',
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
          dailyVolumeLimitUsd: 1_000,
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
        configDir: './veto',
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
        defaultPayer: 'desk-wallet',
        approvedPayers: [],
        scopes: ['session', 'agent', 'category'],
        cloud: {
          baseUrl: 'https://api.veto.so',
          apiKeyEnv: 'VETO_API_KEY',
          timeoutMs: 10_000,
          cacheTtlMs: 30_000,
        },
      },
      marketContext: {
        enabled: true,
        ttlMs: 30_000,
      },
      sessionPolicy: {
        overlayDir: 'rules',
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

function writeWorkspaceFixture(baseDir: string): void {
  mkdirSync(join(baseDir, 'src'), { recursive: true });
  mkdirSync(join(baseDir, 'veto', 'rules'), { recursive: true });

  writeFileSync(
    join(baseDir, 'package.json'),
    JSON.stringify({
      name: 'policy-fixture',
      version: '1.0.0',
      type: 'module',
    }, null, 2),
    'utf-8',
  );

  writeFileSync(
    join(baseDir, 'src', 'tools.ts'),
    [
      'export async function order_market() { return null; }',
      'export async function order_create_limit() { return null; }',
    ].join('\n'),
    'utf-8',
  );

  writeFileSync(
    join(baseDir, 'veto', 'veto.config.yaml'),
    [
      'version: "1.0"',
      'mode: strict',
      'validation:',
      '  mode: local',
      'rules:',
      '  directory: ./rules',
      '  recursive: true',
    ].join('\n'),
    'utf-8',
  );
}

function okBudgetStatus(): EconomicBudgetStatus {
  return {
    enabled: true,
    authority: 'cloud',
    healthy: true,
    pendingApprovals: [],
    budget: {
      currency: 'USD',
      asOf: '2026-03-14T00:00:00.000Z',
      source: 'cloud',
      session: {
        limitUsd: 1_000,
        spentUsd: 100,
        remainingUsd: 900,
      },
    },
  };
}

function okExecution(argv: string[], parsed: unknown) {
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

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('PolicyManager', () => {
  it('creates a deterministic session overlay and reloads local rules', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'policy-manager-'));
    tempDirs.push(baseDir);
    writeWorkspaceFixture(baseDir);

    const reloadRules = vi.fn(async () => {});
    const manager = new PolicyManager({
      projectDir: baseDir,
      vetoConfigDir: join(baseDir, 'veto'),
      sessionId: 'session-test',
      overlayDir: '../rules',
      reloadRules,
      generatePolicyFromPrompt: async () => ({
        mode: 'template',
        warnings: [],
        yaml: [
          'version: "1.0"',
          'rules:',
          '  - id: block-large-orders',
          '    name: Block large orders',
          '    enabled: true',
          '    severity: high',
          '    action: block',
          '    tools: [order_market]',
          '    conditions:',
          '      - field: arguments.amount_usd',
          '        operator: greater_than',
          '        value: 250',
        ].join('\n'),
      }),
    });

    const created = await manager.create({ prompt: 'block large orders' });
    const overlayPath = join(baseDir, 'veto', 'rules', 'session-session-test.generated.yaml');

    expect(created.overlayPath).toBe(overlayPath);
    expect(created.ruleIds).toEqual(['block-large-orders']);
    expect(readFileSync(overlayPath, 'utf-8')).toContain('block-large-orders');
    expect(reloadRules).toHaveBeenCalledTimes(1);
  });

  it('lists session rules with source info and tracks required contexts', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'policy-manager-'));
    tempDirs.push(baseDir);
    writeWorkspaceFixture(baseDir);

    const manager = new PolicyManager({
      projectDir: baseDir,
      vetoConfigDir: join(baseDir, 'veto'),
      sessionId: 'session-test',
      overlayDir: 'rules',
      generatePolicyFromPrompt: async () => ({
        mode: 'template',
        warnings: [],
        yaml: [
          'version: "1.0"',
          'rules:',
          '  - id: market-review',
          '    name: Market review',
          '    enabled: true',
          '    severity: medium',
          '    action: require_approval',
          '    tools: [order_create_limit]',
          '    conditions:',
          '      - field: market.volume',
          '        operator: less_than',
          '        value: 50000',
          '      - field: portfolio.open_count',
          '        operator: greater_than',
          '        value: 3',
        ].join('\n'),
      }),
    });

    await manager.create({ prompt: 'review risky market entries' });
    const listed = await manager.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: 'market-review',
      action: 'require_approval',
      source: expect.stringContaining('session-session-test.generated.yaml'),
    });
    expect(await manager.getRequiredContexts()).toEqual({
      market: true,
      budget: false,
      portfolio: true,
    });
  });

  it('tightens a generated rule by appending a new condition and reloading rules', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'policy-manager-'));
    tempDirs.push(baseDir);
    writeWorkspaceFixture(baseDir);

    const reloadRules = vi.fn(async () => {});
    const manager = new PolicyManager({
      projectDir: baseDir,
      vetoConfigDir: join(baseDir, 'veto'),
      sessionId: 'session-test',
      overlayDir: 'rules',
      reloadRules,
      generatePolicyFromPrompt: async () => ({
        mode: 'template',
        warnings: [],
        yaml: [
          'version: "1.0"',
          'rules:',
          '  - id: allow-small-orders',
          '    name: Allow small orders',
          '    enabled: true',
          '    severity: low',
          '    action: allow',
          '    tools: [order_market]',
          '    conditions:',
          '      - field: arguments.amount_usd',
          '        operator: less_than',
          '        value: 250',
        ].join('\n'),
      }),
    });

    await manager.create({ prompt: 'allow small orders' });
    const tightened = await manager.tighten({
      ruleId: 'allow-small-orders',
      newCondition: {
        field: 'arguments.side',
        operator: 'equals',
        value: 'buy',
      },
    });

    const overlayPath = join(baseDir, 'veto', 'rules', 'session-session-test.generated.yaml');
    const parsed = parseYaml(readFileSync(overlayPath, 'utf-8')) as Record<string, unknown>;
    const rules = Array.isArray(parsed.rules) ? parsed.rules as Array<Record<string, unknown>> : [];
    const conditions = Array.isArray(rules[0]?.conditions) ? rules[0].conditions as Array<Record<string, unknown>> : [];

    expect(tightened.ruleId).toBe('allow-small-orders');
    expect(conditions).toHaveLength(2);
    expect(conditions[1]).toMatchObject({
      field: 'arguments.side',
      operator: 'equals',
      value: 'buy',
    });
    expect(reloadRules).toHaveBeenCalledTimes(2);
  });

  it('rejects tightening block rules that would reduce enforcement', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'policy-manager-'));
    tempDirs.push(baseDir);
    writeWorkspaceFixture(baseDir);

    const manager = new PolicyManager({
      projectDir: baseDir,
      vetoConfigDir: join(baseDir, 'veto'),
      sessionId: 'session-test',
      overlayDir: 'rules',
      generatePolicyFromPrompt: async () => ({
        mode: 'template',
        warnings: [],
        yaml: [
          'version: "1.0"',
          'rules:',
          '  - id: block-large-orders',
          '    name: Block large orders',
          '    enabled: true',
          '    severity: high',
          '    action: block',
          '    tools: [order_market]',
          '    conditions:',
          '      - field: arguments.amount_usd',
          '        operator: greater_than',
          '        value: 250',
        ].join('\n'),
      }),
    });

    await manager.create({ prompt: 'block large orders' });

    await expect(manager.tighten({
      ruleId: 'block-large-orders',
      newCondition: {
        field: 'arguments.side',
        operator: 'equals',
        value: 'buy',
      },
    })).rejects.toThrow('Only allow rules can be tightened automatically');
  });

  it('returns a pending approval request for edits without mutating the overlay', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'policy-manager-'));
    tempDirs.push(baseDir);
    writeWorkspaceFixture(baseDir);

    const manager = new PolicyManager({
      projectDir: baseDir,
      vetoConfigDir: join(baseDir, 'veto'),
      sessionId: 'session-test',
      overlayDir: 'rules',
      generatePolicyFromPrompt: async () => ({
        mode: 'template',
        warnings: [],
        yaml: [
          'version: "1.0"',
          'rules:',
          '  - id: block-large-orders',
          '    name: Block large orders',
          '    enabled: true',
          '    severity: high',
          '    action: block',
          '    tools: [order_market]',
        ].join('\n'),
      }),
    });

    await manager.create({ prompt: 'block large orders' });
    const overlayPath = join(baseDir, 'veto', 'rules', 'session-session-test.generated.yaml');
    const before = readFileSync(overlayPath, 'utf-8');
    const requested = await manager.requestEdit({
      ruleId: 'block-large-orders',
      changes: {
        action: 'allow',
      },
    });
    const after = readFileSync(overlayPath, 'utf-8');

    expect(requested.status).toBe('pending_approval');
    expect(after).toBe(before);
  });
});

describe('runtime policy context integration', () => {
  it('passes market, budget, and portfolio context into guard checks', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'runtime-policy-'));
    tempDirs.push(baseDir);
    writeWorkspaceFixture(baseDir);

    const calls: Array<Record<string, unknown>> = [];
    const guard = vi.fn(async (_toolName: string, _args: Record<string, unknown>, context: unknown): Promise<RuntimeDecision> => {
      calls.push(context as Record<string, unknown>);
      return { decision: 'allow' };
    });

    const economicClient: EconomicCloudClient = {
      authorize: async () => ({
        decision: 'allow',
        reasonCode: 'economic_ok',
        message: 'ok',
        authority: 'cloud',
      }),
      commit: async () => ({
        status: 'preview',
        authority: 'cloud',
        category: 'trade',
      }),
      status: async () => okBudgetStatus(),
    };

    const runtime = await PolymarketVetoRuntime.create(
      {
        ...makeConfig(baseDir),
        config: {
          ...makeConfig(baseDir).config,
          economic: {
            ...makeConfig(baseDir).config.economic,
            enabled: true,
          },
        },
      },
      {
        guard: {
          guard,
        },
        economicClient,
        marketContextResolver: {
          resolve: vi.fn(async () => ({
            token: 'token-1',
            category: 'crypto',
            volume: 75_000,
            spread: 0.02,
          })),
          clear: vi.fn(),
        },
        policyManager: {
          create: vi.fn(),
          list: vi.fn(async () => []),
          tighten: vi.fn(),
          requestEdit: vi.fn(),
          getRequiredContexts: vi.fn(async () => ({ market: false, budget: false, portfolio: false })),
        },
        execute: async (_binary, argv) => okExecution(argv, { midpoint: 0.51 }),
      },
    );

    await runtime.callTool('budget_status', {});
    await runtime.callTool('order_market', { token: 'token-1', side: 'buy', amount: 25 });

    const orderCall = calls.at(-1) ?? {};
    expect(orderCall).toMatchObject({
      market: {
        token: 'token-1',
        category: 'crypto',
        volume: 75_000,
      },
      budget: {
        remainingUsd: 900,
      },
      portfolio: {
        open_count: 0,
      },
      custom: {
        arguments: {
          token: 'token-1',
          side: 'buy',
          amount: 25,
        },
        market: {
          token: 'token-1',
          category: 'crypto',
          volume: 75_000,
        },
        budget: {
          remainingUsd: 900,
        },
        portfolio: {
          open_count: 0,
        },
      },
    });
  });

  it('loads market context through the default resolver when none is injected', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'runtime-policy-'));
    tempDirs.push(baseDir);
    writeWorkspaceFixture(baseDir);

    const calls: Array<Record<string, unknown>> = [];
    const guard = vi.fn(async (_toolName: string, _args: Record<string, unknown>, context: unknown): Promise<RuntimeDecision> => {
      calls.push(context as Record<string, unknown>);
      return { decision: 'allow' };
    });

    const runtime = await PolymarketVetoRuntime.create(makeConfig(baseDir), {
      guard: {
        guard,
      },
      policyManager: {
        create: vi.fn(),
        list: vi.fn(async () => []),
        tighten: vi.fn(),
        requestEdit: vi.fn(),
        getRequiredContexts: vi.fn(async () => ({ market: false, budget: false, portfolio: false })),
      },
      execute: async (_binary, argv) => {
        if (argv[0] === 'markets' && argv[1] === 'get') {
          return okExecution(argv, {
            token: 'token-1',
            category: 'crypto',
            volume: 25_000,
            liquidityUsd: 9_000,
            bestBid: 0.49,
            bestAsk: 0.51,
            endDate: '2026-12-31T00:00:00.000Z',
          });
        }

        return okExecution(argv, {
          bids: [],
          asks: [],
        });
      },
    });

    await runtime.callTool('clob_book', { token: 'token-1' });

    expect(calls.at(-1)).toMatchObject({
      market: {
        token: 'token-1',
        category: 'crypto',
        volume: 25_000,
        liquidityUsd: 9_000,
        spread: 0.04,
        end_date: '2026-12-31T00:00:00.000Z',
      },
      custom: {
        arguments: {
          token: 'token-1',
        },
        market: {
          token: 'token-1',
          category: 'crypto',
          volume: 25_000,
          liquidityUsd: 9_000,
        },
      },
    });
  });

  it('requires approval when required market context is missing', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'runtime-policy-'));
    tempDirs.push(baseDir);
    writeWorkspaceFixture(baseDir);

    const guard = vi.fn(async (): Promise<RuntimeDecision> => ({ decision: 'allow' }));
    const runtime = await PolymarketVetoRuntime.create(makeConfig(baseDir), {
      guard: {
        guard,
      },
      marketContextResolver: {
        resolve: vi.fn(async () => null),
        clear: vi.fn(),
      },
      policyManager: {
        create: vi.fn(),
        list: vi.fn(async () => []),
        tighten: vi.fn(),
        requestEdit: vi.fn(),
        getRequiredContexts: vi.fn(async () => ({ market: true, budget: false, portfolio: false })),
      },
      execute: async (_binary, argv) => okExecution(argv, { midpoint: 0.51 }),
    });

    let error: unknown;
    try {
      await runtime.callTool('order_market', { token: 'token-1', side: 'buy', amount: 25 });
    } catch (caught) {
      error = caught;
    }

    const mapped = runtime.toRpcError(error);
    expect(mapped.code).toBe(-32002);
    expect(mapped.message).toContain('Required market context unavailable');
    expect(guard).not.toHaveBeenCalled();
  });
});
