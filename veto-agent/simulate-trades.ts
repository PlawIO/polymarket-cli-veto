#!/usr/bin/env tsx
/**
 * Simulated trade runner — exercises the four policy profiles against a
 * representative set of order scenarios and prints a decision table.
 *
 * Runs entirely in local validation mode (no cloud API calls needed).
 * Mutating tools run in simulation mode — no real orders are placed.
 *
 * Usage:
 *   cd polymarket-cli-veto
 *   npx tsx scripts/simulate-trades.ts
 */

import { resolve } from 'node:path';
import { loadConfig } from './src/config.js';
import { PolymarketVetoRuntime } from './src/runtime.js';
import type { PolicyProfile } from './src/types.js';

// ─── Colour helpers ──────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  magenta: '\x1b[35m',
};

function col(text: string, ...codes: string[]): string {
  return codes.join('') + text + C.reset;
}

// ─── Scenario definitions ────────────────────────────────────────────────────

interface Scenario {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  note?: string;
}

// A plausible token ID for an active market (used for simulation context only)
const EXAMPLE_TOKEN = '71321045679252212594626385532706912750332728571942532289631379312455583992563';

const SCENARIOS: Scenario[] = [
  // ── Reads (should always pass through) ──────────────────────────────────
  {
    label: 'Search markets',
    tool: 'markets_search',
    args: { query: 'US election 2026', limit: 3 },
  },

  // ── Small buy — $10 limit order ──────────────────────────────────────────
  {
    label: 'Buy 100 shares @ $0.10 ($10 limit)',
    tool: 'order_create_limit',
    args: { token: EXAMPLE_TOKEN, side: 'buy', price: 0.10, size: 100 },
    note: 'Under $25: defaults/agent allow; user allows during market hours, requires approval off-hours/weekends; conservative requires approval',
  },

  // ── Medium buy — $30 limit order ────────────────────────────────────────
  {
    label: 'Buy 300 shares @ $0.10 ($30 limit)',
    tool: 'order_create_limit',
    args: { token: EXAMPLE_TOKEN, side: 'buy', price: 0.10, size: 300 },
    note: 'Triggers defaults/agent $25 threshold; user still allows (under $100)',
  },

  // ── Large buy — $150 limit order ────────────────────────────────────────
  {
    label: 'Buy 1500 shares @ $0.10 ($150 limit)',
    tool: 'order_create_limit',
    args: { token: EXAMPLE_TOKEN, side: 'buy', price: 0.10, size: 1500 },
    note: 'Triggers user $100 threshold; blocked on user over $500 should not fire',
  },

  // ── Oversized order — $600 ───────────────────────────────────────────────
  {
    label: 'Buy 6000 shares @ $0.10 ($600 limit)',
    tool: 'order_create_limit',
    args: { token: EXAMPLE_TOKEN, side: 'buy', price: 0.10, size: 6000 },
    note: 'Should be hard-blocked by user policy ($500 cap)',
  },

  // ── Near-resolution buy — price > $0.97 ─────────────────────────────────
  {
    label: 'Buy 10 shares @ $0.99 (near-resolution)',
    tool: 'order_create_limit',
    args: { token: EXAMPLE_TOKEN, side: 'buy', price: 0.99, size: 10 },
    note: 'Blocked by user price discipline rule',
  },

  // ── Sell order ───────────────────────────────────────────────────────────
  {
    label: 'Sell 100 shares @ $0.55',
    tool: 'order_create_limit',
    args: { token: EXAMPLE_TOKEN, side: 'sell', price: 0.55, size: 100 },
    note: 'user: require approval for all sells',
  },

  // ── Market order — $20 ──────────────────────────────────────────────────
  {
    label: 'Market buy $20',
    tool: 'order_market',
    args: { token: EXAMPLE_TOKEN, side: 'buy', amount: 20 },
  },

  // ── Market order — $30 ──────────────────────────────────────────────────
  {
    label: 'Market buy $30',
    tool: 'order_market',
    args: { token: EXAMPLE_TOKEN, side: 'buy', amount: 30 },
    note: 'Crosses defaults/agent $25 threshold',
  },

  // ── FOK order — $60 (large FOK blocked on user) ───────────────────────
  {
    label: 'FOK buy 600 shares @ $0.10 ($60)',
    tool: 'order_create_limit',
    args: { token: EXAMPLE_TOKEN, side: 'buy', price: 0.10, size: 600, orderType: 'FOK' },
    note: 'user: FOK blocked above $50',
  },

  // ── Cancel all — hard block on user ─────────────────────────────────────
  {
    label: 'Cancel all orders',
    tool: 'order_cancel_all',
    args: {},
    note: 'Blocked on user; require_approval on defaults/agent/conservative',
  },

  // ── CTF split — hard block everywhere ───────────────────────────────────
  {
    label: 'CTF split $50',
    tool: 'ctf_split',
    args: { condition: '0xabc123', amount: 50 },
    note: 'Blocked on all profiles',
  },

];

// ─── Result formatting ───────────────────────────────────────────────────────

type DecisionTag = 'allow' | 'require_approval' | 'deny' | 'error';

interface Result {
  tag: DecisionTag;
  detail: string;
  simulation?: boolean;
}

function decisionColor(tag: DecisionTag): string {
  switch (tag) {
    case 'allow': return C.green + C.bold;
    case 'require_approval': return C.yellow + C.bold;
    case 'deny': return C.red + C.bold;
    case 'error': return C.magenta;
  }
}

function decisionLabel(tag: DecisionTag): string {
  switch (tag) {
    case 'allow': return 'ALLOW  ';
    case 'require_approval': return 'APPROVE';
    case 'deny': return 'BLOCK  ';
    case 'error': return 'ERROR  ';
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const PROFILES: PolicyProfile[] = ['defaults', 'user', 'agent', 'conservative'];

async function runScenario(
  runtime: PolymarketVetoRuntime,
  scenario: Scenario,
): Promise<Result> {
  try {
    const result = await runtime.callTool(scenario.tool, scenario.args, true /* simulationOverride=on */);
    const text = result.content[0]?.text ?? '';
    let simulation = false;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      simulation = parsed.simulation === true;
    } catch { /* non-json output is fine */ }
    return { tag: 'allow', detail: simulation ? '[simulated]' : '[read-only]', simulation };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('Denied by policy:')) {
      const inner = msg.slice('Denied by policy:'.length).trim();
      return { tag: 'deny', detail: inner };
    }
    if (msg.startsWith('Approval required:') || msg.includes('require_approval')) {
      return { tag: 'require_approval', detail: msg.replace(/^Approval required:\s*/, '') };
    }
    return { tag: 'error', detail: msg.slice(0, 80) };
  }
}

async function buildRuntime(profile: PolicyProfile): Promise<PolymarketVetoRuntime> {
  const configPath = resolve(import.meta.dirname, './polymarket-veto.config.yaml');
  const resolved = loadConfig(configPath);
  resolved.config.veto.policyProfile = profile;
  resolved.config.execution.simulationDefault = true;
  return PolymarketVetoRuntime.create(resolved);
}

async function main(): Promise<void> {
  console.log(`\n${col('  Polymarket — Simulated Trade Session', C.bold, C.cyan)}`);
  console.log(col('  validation=local  simulation=on  no real orders placed\n', C.dim));

  // Build one runtime per profile
  const runtimes = new Map<PolicyProfile, PolymarketVetoRuntime>();
  for (const profile of PROFILES) {
    runtimes.set(profile, await buildRuntime(profile));
  }

  // Column widths
  const labelWidth = Math.max(...SCENARIOS.map((s) => s.label.length), 30);
  const colWidth = 10;

  // Header
  const header =
    '  ' +
    'SCENARIO'.padEnd(labelWidth + 2) +
    PROFILES.map((p) => p.padEnd(colWidth)).join('');
  console.log(col(header, C.bold));
  console.log('  ' + '─'.repeat(labelWidth + 2 + PROFILES.length * colWidth));

  // Run each scenario
  for (const scenario of SCENARIOS) {
    const results = await Promise.all(
      PROFILES.map((p) => runScenario(runtimes.get(p)!, scenario)),
    );

    const label = scenario.label.padEnd(labelWidth + 2);
    const cols = results
      .map((r) => col(decisionLabel(r.tag).padEnd(colWidth), decisionColor(r.tag)))
      .join('');

    console.log(`  ${label}${cols}`);

    if (scenario.note) {
      console.log(col(`  ${''.padEnd(labelWidth + 2)}${scenario.note}`, C.dim));
    }
  }

  // Legend
  console.log('\n  ' + '─'.repeat(labelWidth + 2 + PROFILES.length * colWidth));
  console.log(`  ${col('ALLOW  ', C.green + C.bold)}  policy passed — order would execute (simulated)`);
  console.log(`  ${col('APPROVE', C.yellow + C.bold)}  policy requires human approval`);
  console.log(`  ${col('BLOCK  ', C.red + C.bold)}  policy hard-blocked the operation`);
  console.log(`  ${col('ERROR  ', C.magenta)}  tool/arg error (not a policy decision)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
