---
name: polymarket-veto
description: Polymarket trading through a guarded MCP server. Use when the user asks about Polymarket markets, wants to place trades, manage orders, or check prices through an AI agent. Activates for prediction markets, CLOB trading, order management, or any Polymarket-related task.
license: MIT
metadata:
  author: PlawIO
  version: "1.0.0"
  argument-hint: "<tool-name or setup>"
---

# Polymarket Veto — Guarded Trading for AI Agents

This skill provides context for using the `@plawio/polymarket-veto-mcp` MCP server, which wraps the Polymarket CLI with policy guardrails. Every mutating tool call is validated against YAML rules before execution. Simulation mode is on by default — no real orders are placed unless explicitly unlocked.

## Setup

If the MCP server is not yet configured, run the setup script:

```bash
bash ~/.claude/skills/polymarket-veto/scripts/setup.sh
```

This writes a `.mcp.json` to the current project directory. You can pass a profile:

```bash
bash ~/.claude/skills/polymarket-veto/scripts/setup.sh user
```

To verify the server is healthy:

```bash
npx -y @plawio/polymarket-veto-mcp doctor
```

## Tools

### Read-only (no policy gating)

| Tool | Purpose | Key args |
|------|---------|----------|
| `markets_list` | List markets | `limit`, `active`, `closed` |
| `markets_search` | Search by text | `query`, `limit` |
| `markets_get` | Market details | `market` (id or slug) |
| `clob_book` | Order book | `token` |
| `clob_midpoint` | Midpoint price | `token` |
| `clob_price` | CLOB price | `token`, `side` |
| `portfolio_positions` | Wallet positions | `address` |

Use these freely to research before placing any orders.

### Mutating (policy-guarded, simulation by default)

| Tool | Purpose | Key args |
|------|---------|----------|
| `order_create_limit` | Limit order | `token`, `side`, `price`, `size`, optional `orderType` (GTC/FOK/GTD/FAK), `postOnly` |
| `order_market` | Market order | `token`, `side`, `amount` |
| `order_cancel` | Cancel one order | `orderId` |
| `order_cancel_all` | Cancel all orders | (none) |
| `approve_set` | On-chain approvals | (none) |
| `ctf_split` | Split USDC to tokens | `condition`, `amount` |
| `ctf_merge` | Merge tokens to USDC | `condition`, `amount` |
| `ctf_redeem` | Redeem winners | `condition` |

### Never exposed

`wallet_import`, `wallet_reset`, `clob_delete_api_key` — rejected at the MCP layer with error code `-32601`. The guard is never invoked.

## Policy profiles

The active profile determines what happens when a mutating tool is called. Four profiles are available:

### `defaults` — launch-safe baseline
- Orders under $25: allow
- Orders over $25: require approval
- Cancel-all: require approval
- CTF ops: deny

### `agent` — autonomous bots
- Same as defaults, plus off-hours gate (8am–8pm ET weekdays)
- Weekends not explicitly gated

### `user` — human-delegated trading
- Hard cap: orders > $500 denied
- Orders > $100: require approval
- All sells: require approval (any size)
- Buys > $0.97: denied (near-resolution)
- Sells < $0.03: denied
- FOK orders > $50: denied
- Off-hours + weekends: require approval
- Cancel-all: denied
- CTF ops: denied

### `conservative` — experimental
- All mutations: require approval
- CTF ops: denied

## Decision matrix (weekday business hours)

| Scenario | defaults | agent | user | conservative |
|----------|----------|-------|------|--------------|
| Buy $10 | allow | allow | allow | approval |
| Buy $30 | approval | approval | allow | approval |
| Buy $150 | approval | approval | approval | approval |
| Buy $600 | approval | approval | **deny** | approval |
| Buy @ $0.99 | allow | allow | **deny** | approval |
| Sell any | allow | allow | approval | approval |
| FOK buy $60 | allow | allow | **deny** | approval |
| Cancel all | approval | approval | **deny** | approval |
| CTF ops | **deny** | **deny** | **deny** | **deny** |

## Error codes and how to respond

| Code | Meaning | What to do |
|------|---------|------------|
| `-32601` | Unknown tool | Tool doesn't exist in the MCP registry. Don't retry. |
| `-32602` | Invalid arguments | Fix the arguments and retry. |
| `-32001` | Denied by policy | The active profile blocks this operation. Explain the rule to the user. Suggest changing profile or adjusting parameters. |
| `-32002` | Approval required | A human must approve this. The system is waiting. Tell the user approval is needed and why. |
| `-32003` | Execution failed | Binary missing, approval polling failed, or command error. Run `doctor` to diagnose. |

## Workflow best practices

1. **Research first.** Use `markets_search`, `markets_get`, `clob_book`, `clob_midpoint` to understand a market before placing orders. These are free and fast.

2. **Explain simulation.** Mutating tools run in simulation by default. When a trade executes successfully, tell the user it was simulated and show the estimated shares/notional. Don't say "order placed" — say "simulated order" with the estimates.

3. **Respect denials.** When a tool returns `-32001`, don't retry with the same parameters. Explain which rule blocked the operation and what the user's options are (lower amount, different profile, manual execution).

4. **Handle approvals gracefully.** When a tool returns `-32002`, explain that the operation requires human approval and why. The system blocks until the approval is resolved — don't keep polling or retrying.

5. **Know the active profile.** If you don't know which profile is active, the default is `defaults`. You can check by running `npx -y @plawio/polymarket-veto-mcp print-config` and looking at `veto.policyProfile`.

6. **Size awareness.** For limit orders, `amount_usd = price * size`. For market orders, `amount_usd = amount`. Policy thresholds apply to `amount_usd`. Calculate this before placing an order to predict whether it will be allowed, require approval, or be denied.

7. **Token IDs matter.** Polymarket uses long numeric token IDs (e.g., `71321045679252212594626385532706912750332728571942532289631379312455583992563`). Get the correct token ID from `markets_get` before placing orders.

## Simulation vs live trading

By default, all mutating tools run in simulation mode. The simulation:
- Looks up the current midpoint price
- Estimates shares and notional value
- Returns a result with `"simulation": true`
- Does NOT place any real order

Live trading requires **all three** to be true:
1. Server started with `--simulation off`
2. Config: `execution.allowLiveTrades: true`
3. Environment: `ALLOW_LIVE_TRADES=true`

Never recommend enabling live trading unless the user explicitly asks for it.
