# @plawio/polymarket-veto-mcp

Guarded MCP sidecar for Polymarket CLI powered by [Veto](https://github.com/PlawIO/veto).

**Polymarket CLI, but safe for agents.**

## What it does

- Exposes a fixed set of Polymarket MCP tools (no arbitrary shell passthrough).
- Validates every tool call through Veto policy rules before execution.
- Defaults to simulation for all mutating actions — no real orders unless explicitly unlocked.
- Ships four policy profiles covering autonomous bots, human-delegated trading, and experimentation.
- Wallet-mutating tools (`wallet_import`, `wallet_reset`, `clob_delete_api_key`) are architecturally excluded at the MCP tool registry — they never reach the guard.

## Install and run

```bash
npx -y @plawio/polymarket-veto-mcp serve
```

Defaults: `--policy-profile defaults`, simulation on, live trading disabled.

For human-delegated trading with stronger guardrails:

```bash
npx -y @plawio/polymarket-veto-mcp serve --policy-profile user
```

### Required: Polymarket CLI binary

This package wraps the Rust `polymarket` CLI. Install it first:

```bash
# Option A: Homebrew
brew install polymarket

# Option B: build from repo root
cargo build --release
```

Verify with `polymarket --version`. If you built locally, set `polymarket.binaryPath` in `polymarket-veto.config.yaml` or the binary will be auto-discovered from `target/release/`.

## Policy profiles

All profiles block wallet-mutating and raw CTF operations. They differ in how they gate order placement.

### `defaults` — launch-safe baseline

Orders under $25 pass through. Larger orders and cancel-all require approval. No time-of-day restrictions.

### `agent` — autonomous trading bots

Same $25 threshold as defaults, plus an off-hours gate: orders placed outside 8am–8pm ET on weekdays require approval. Weekends are uncovered (no explicit weekend rule).

### `user` — human trader delegating to an agent

The most layered profile. Designed for users who want an AI agent to trade on their behalf with strong guardrails:

- **Hard cap**: orders > $500 blocked
- **Large order approval**: orders > $100 require approval
- **Sell discipline**: all sells require approval regardless of size
- **Price discipline**: buys above $0.97 (near-resolution) blocked, sells below $0.03 blocked
- **FOK cap**: fill-or-kill orders > $50 blocked
- **Off-hours**: weekday trades outside 6am–11pm ET and all weekend trades require approval
- **Cancel-all**: blocked (use single-order cancel instead)

### `conservative` — assisted/experimental

Every mutating operation requires approval. Use this when exploring or testing new strategies.

### Decision matrix

How each profile handles representative scenarios during weekday business hours:

| Scenario | defaults | agent | user | conservative |
|----------|----------|-------|------|--------------|
| Read-only (search, book, price) | allow | allow | allow | allow |
| Buy $10 limit | allow | allow | allow | require_approval |
| Buy $30 limit | require_approval | require_approval | allow | require_approval |
| Buy $150 limit | require_approval | require_approval | require_approval | require_approval |
| Buy $600 limit | require_approval | require_approval | **deny** | require_approval |
| Buy @ $0.99 (near-resolution) | allow | allow | **deny** | require_approval |
| Sell (any size) | allow | allow | require_approval | require_approval |
| FOK buy $60 | allow | allow | **deny** | require_approval |
| Cancel all | require_approval | require_approval | **deny** | require_approval |
| CTF split/merge/redeem | **deny** | **deny** | **deny** | **deny** |
| Wallet import/reset/delete key | rejected at MCP layer | rejected at MCP layer | rejected at MCP layer | rejected at MCP layer |

## Tool set

**Read-only** (no policy gating):

`markets_list`, `markets_search`, `markets_get`, `clob_book`, `clob_midpoint`, `clob_price`, `portfolio_positions`

**Mutating** (policy-guarded):

`order_create_limit`, `order_market`, `order_cancel`, `order_cancel_all`, `approve_set`, `ctf_split`, `ctf_merge`, `ctf_redeem`

**Architecturally excluded** (not registered as MCP tools):

`wallet_import`, `wallet_reset`, `clob_delete_api_key`

These return `-32601 Unknown tool` if called — the guard is never invoked.

## Commands

```bash
polymarket-veto-mcp serve [options]    # Start MCP server
polymarket-veto-mcp doctor             # Diagnose binary, config, rules
polymarket-veto-mcp print-tools        # List registered MCP tools
polymarket-veto-mcp print-config       # Dump resolved config
```

Serve options: `--config <path>`, `--policy-profile defaults|agent|user|conservative`, `--simulation on|off`, `--transport stdio|sse`, `--host <ip>`, `--port <port>`

## MCP client config

Works from any working directory:

```json
{
  "mcpServers": {
    "polymarket-veto": {
      "command": "npm",
      "args": [
        "exec", "--yes", "--prefix", "/tmp",
        "--package", "@plawio/polymarket-veto-mcp",
        "--", "polymarket-veto-mcp", "serve",
        "--policy-profile", "defaults"
      ]
    }
  }
}
```

If `npx` fails inside the package source directory, use `pnpm dlx` or `bunx` instead.

## Simulation vs live trading

Mutating tools run in simulation mode by default. Simulation estimates shares and notional value using live midpoint data without placing real orders.

Live execution requires **all three**:

1. `--simulation off` at startup
2. `execution.allowLiveTrades: true` in `polymarket-veto.config.yaml`
3. `ALLOW_LIVE_TRADES=true` environment variable

## Configuration

Config path: `polymarket-veto.config.yaml` (searched in cwd, then defaults).

```yaml
polymarket:
  binaryPath: auto            # auto | command name | explicit path

execution:
  simulationDefault: true
  allowLiveTrades: false
  maxCommandTimeoutMs: 15000
  maxOutputBytes: 1048576

mcp:
  transport: stdio            # stdio | sse
  host: 127.0.0.1
  port: 9800

veto:
  configDir: ../veto          # path to veto/ with rules and veto.config.yaml
  policyProfile: defaults
  cloud:
    apiKeyEnv: VETO_API_KEY
```

### Cloud mode (optional)

Local deterministic validation works out of the box. For cloud-backed validation with the Veto dashboard:

```bash
export VETO_API_KEY=veto_xxx
```

Then set `validation.mode: cloud` in `veto/veto.config.yaml`.

## Development

```bash
cd veto-agent
npm install
npm run typecheck    # type check src/
npm test             # run all tests
npm run build        # compile to dist/
npm run simulate     # run policy decision table across all profiles
```

### Testing

Tests cover three layers:

- **Policy evaluation** (`tests/policy.test.ts`) — exercises real YAML rules through `Veto.init()` with local validation. Tests all four profiles across order sizing, price discipline, sell-side, FOK limits, timestamp conditions, and CTF blocking. Includes a cross-profile CTF regression suite.
- **Runtime decisions** (`tests/runtime.test.ts`) — tests the MCP runtime's decision mapping (deny, approval, simulation), approval polling, and wallet tool boundary rejection.
- **Tool building** (`tests/tools.test.ts`) — validates CLI argument construction and guard argument computation for each tool.

### Simulate

`npm run simulate` prints a color-coded decision table showing how each profile handles a set of representative scenarios:

```
  SCENARIO                              defaults  user      agent     conservative
  ────────────────────────────────────────────────────────────────────────────────
  Search markets                        ALLOW     ALLOW     ALLOW     ALLOW
  Buy 100 shares @ $0.10 ($10 limit)    ALLOW     ALLOW     ALLOW     APPROVE
  Buy 300 shares @ $0.10 ($30 limit)    APPROVE   ALLOW     APPROVE   APPROVE
  ...
  CTF split $50                         BLOCK     BLOCK     BLOCK     BLOCK
```

Runs entirely in local validation mode with simulation on — no real orders, no cloud calls.

## License

MIT
