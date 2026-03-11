# Polymarket CLI Veto

Upstream Polymarket CLI, plus a Veto-powered MCP sidecar for AI agents.

This repo is the practical bundle:
- the Rust `polymarket` CLI for market access and execution
- the `@plawio/polymarket-veto-mcp` sidecar in [`veto-agent`](./veto-agent)
- Claude Code skill wiring in [`skills/polymarket-veto`](./skills/polymarket-veto)
- sample Veto rules and config in [`veto`](./veto)

The point of the bundle is simple:

Your model suggests.  
Veto permits.

Every capital-moving action can be checked before execution against policy, approvals, budget state, payer constraints, and live-vs-simulation rules.

## What This Repo Gives You

### 1. Polymarket CLI

The Rust CLI still works as a normal terminal and script tool:

```bash
polymarket markets list --limit 5
polymarket markets search "bitcoin"
polymarket markets get will-trump-win
polymarket -o json markets list --limit 3
```

### 2. Veto MCP Server

The sidecar exposes guarded MCP tools for agents:
- market reads
- order placement and cancellation
- approval-aware execution
- runtime readiness and budget inspection
- x402-backed paid research

Key agent-facing tools:
- `markets_list`, `markets_search`, `markets_get`
- `clob_book`, `clob_midpoint`, `clob_price`
- `order_create_limit`, `order_market`, `order_cancel`, `order_cancel_all`
- `budget_status`, `runtime_status`, `approval_status`
- `intel_search`, `intel_market_context`

Architecturally excluded:
- `wallet_import`
- `wallet_reset`
- `clob_delete_api_key`

## Quick Start

### Claude Code

1. Build or install the Polymarket CLI:

```bash
brew install polymarket
# or from this repo:
cargo build --release
```

2. Install the MCP sidecar deps:

```bash
pnpm --dir veto-agent install
pnpm --dir veto-agent build
```

3. Install the Claude skill:

```bash
cp -r skills/polymarket-veto ~/.claude/skills/
bash ~/.claude/skills/polymarket-veto/scripts/setup.sh
```

4. Restart Claude Code.

At that point the agent can use the Veto-wrapped Polymarket tools through MCP.

### Any MCP Host

```json
{
  "mcpServers": {
    "polymarket-veto": {
      "command": "npm",
      "args": [
        "exec",
        "--yes",
        "--prefix",
        "/tmp",
        "--package",
        "@plawio/polymarket-veto-mcp",
        "--",
        "polymarket-veto-mcp",
        "serve",
        "--policy-profile",
        "defaults"
      ]
    }
  }
}
```

Or locally from this repo:

```bash
pnpm --dir veto-agent exec tsx src/bin.ts serve --config polymarket-veto.config.yaml
```

## How It Works

For priced actions, the runtime loop is:

1. Agent proposes an action.
2. Veto policy evaluates it.
3. Economic authorization evaluates payer, budget, and approval requirements.
4. Runtime returns one of:
   - allow
   - deny
   - require approval
5. If allowed, the CLI action or x402 call executes.
6. Actual spend is committed back to the authority.

This means the agent never gets to move capital first and explain later.

## Profiles

Profiles define the default policy posture:

| Profile | Behavior |
| --- | --- |
| `defaults` | Small orders allowed, larger orders require approval |
| `agent` | Defaults plus off-hours gating |
| `user` | Harder caps, sell-side approvals, price discipline |
| `conservative` | Every mutation requires approval |

You can set the profile with `--policy-profile <name>` when starting the MCP server.

## Approval Flow

Approval handling is configurable in the sidecar:

- `runtime.approvalMode: return`
  The MCP call returns immediately with `approvalId`, `pending`, and context so the agent can keep working and check `approval_status` later.
- `runtime.approvalMode: wait`
  The MCP call blocks and polls until approval resolves or times out.

The checked-in sample config defaults to `return` because it is the better agent UX.

## Simulation and Live Trading

Mutating tools simulate by default.

Simulation means:
- the runtime estimates notional and shares
- policy and economic checks still apply
- no real order is submitted
- x402 tools stop at quote discovery and do not settle payment

Live execution requires all three:

1. start the server with `--simulation off`
2. set `execution.allowLiveTrades: true`
3. export `ALLOW_LIVE_TRADES=true`

## Economic Authorization and x402

The sidecar can govern both:
- Polymarket trading notional
- x402-paid research spend

The same runtime can:
- enforce payer requirements
- enforce approved payer lists
- request budget authorization
- fail closed on live priced actions when the authority is unavailable
- return cached previews for simulation
- attach `economic` receipts to priced tool responses

x402 tools:
- `intel_search`
- `intel_market_context`

## Commands

### Polymarket CLI

Examples:

```bash
polymarket markets list --limit 10
polymarket markets search "fed"
polymarket clob midpoint <token>
polymarket clob book <token>
```

Build locally:

```bash
cargo build --release
./target/release/polymarket --version
```

### Veto MCP Sidecar

```bash
pnpm --dir veto-agent exec tsx src/bin.ts serve --config polymarket-veto.config.yaml
pnpm --dir veto-agent exec tsx src/bin.ts doctor --config polymarket-veto.config.yaml
pnpm --dir veto-agent exec tsx src/bin.ts status --config polymarket-veto.config.yaml
pnpm --dir veto-agent exec tsx src/bin.ts approval-status --approval-id <id> --config polymarket-veto.config.yaml
pnpm --dir veto-agent exec tsx src/bin.ts print-tools --config polymarket-veto.config.yaml
pnpm --dir veto-agent exec tsx src/bin.ts print-config --config polymarket-veto.config.yaml
```

## Local Development

### Rust CLI

```bash
cargo test
cargo build --release
```

### Veto Agent

```bash
pnpm --dir veto-agent install
pnpm --dir veto-agent typecheck
pnpm --dir veto-agent test
pnpm --dir veto-agent build
```

## Repo Map

- [`veto-agent/README.md`](./veto-agent/README.md)
  Full MCP tool reference, config surface, approval behavior, economic auth, and x402 docs.
- [`veto-agent/polymarket-veto.config.yaml`](./veto-agent/polymarket-veto.config.yaml)
  Sample sidecar config.
- [`veto/`](./veto)
  Sample Veto policy config and rules.
- [`skills/polymarket-veto`](./skills/polymarket-veto)
  Claude Code skill and setup flow.

## Current Status

This repo is intentionally opinionated toward agent use:
- simulation-first
- policy before execution
- approval-aware runtime behavior
- capital authorization hooks for priced actions

If you just want the raw Polymarket CLI, the Rust binary is still here.
If you want an AI agent to operate with hard capital controls, this is the repo.
