# @plawio/polymarket-veto-mcp

Guarded MCP server for Polymarket CLI, powered by [Veto](https://github.com/PlawIO/veto). Lets AI agents search markets, place orders, and manage positions — with every mutation validated against policy rules before execution. Simulation by default, no real money moves unless you explicitly opt in.

## Get started

### Claude Code (recommended)

```bash
# 1. Install the polymarket CLI
brew install polymarket

# 2. Install the agent skill + connect the MCP server
cp -r skills/polymarket-veto ~/.claude/skills/
bash ~/.claude/skills/polymarket-veto/scripts/setup.sh

# 3. Restart Claude Code — done.
```

The skill teaches your agent the full tool set, policy profiles, error handling, and simulation semantics. The setup script writes `.mcp.json` to your project so the MCP server starts automatically.

To use a specific profile (see [Pick a profile](#pick-a-profile)):

```bash
bash ~/.claude/skills/polymarket-veto/scripts/setup.sh user
```

### Any MCP host

Add to your MCP config file:

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

Or run directly:

```bash
npx -y @plawio/polymarket-veto-mcp serve --policy-profile defaults
```

### Prerequisites

This package wraps the Rust `polymarket` CLI binary. Install it before starting the server:

```bash
brew install polymarket           # Option A: Homebrew
cargo build --release             # Option B: build from repo root
polymarket --version              # verify
```

If you built locally, the binary is auto-discovered from `target/release/`. You can also set `polymarket.binaryPath` in `polymarket-veto.config.yaml`.

## Pick a profile

All profiles block wallet-mutating and raw CTF operations. They differ in how they gate order placement. Pass `--policy-profile <name>` when starting the server.

| Profile | Who it's for | What happens |
|---------|-------------|--------------|
| **`defaults`** | Getting started | Orders under $25 go through. Larger orders and cancel-all need approval. No time-of-day limits. |
| **`agent`** | Autonomous bots | Same as defaults + off-hours gate (outside 8am–8pm ET weekdays need approval). |
| **`user`** | Human delegating to AI | Hard cap $500, orders > $100 need approval, all sells need approval, price guardrails (no buys > $0.97, no sells < $0.03), FOK > $50 blocked, off-hours + weekends need approval, cancel-all blocked. |
| **`conservative`** | Testing new strategies | Every mutation needs approval. Nothing goes through automatically. |

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
