# polymarket-veto skill

Agent skill for [Polymarket Veto MCP](../../veto-agent/README.md) — teaches AI agents how to trade on Polymarket safely through the guarded MCP server.

## What this skill provides

When loaded, the agent understands:

- All available MCP tools (read-only and mutating) with their arguments
- Policy profiles and what each one allows, gates, or blocks
- How to handle denials, approvals, and simulation results
- Best practices: research before trading, explain simulation, respect guardrails

## Install

### Claude Code

```bash
# From the repo
cp -r skills/polymarket-veto ~/.claude/skills/

# Or via npx (if skills CLI is available)
npx skills add PlawIO/polymarket-cli-veto
```

### Claude.ai

Upload `SKILL.md` to your Project's Knowledge section.

## Configure the MCP server

After installing the skill, set up the MCP server in your project:

```bash
bash ~/.claude/skills/polymarket-veto/scripts/setup.sh
```

This creates `.mcp.json` in your current directory. Pass a profile name to change the default:

```bash
bash ~/.claude/skills/polymarket-veto/scripts/setup.sh user
```

Restart Claude Code after setup to connect to the new MCP server.

## Profiles

| Profile | Best for |
|---------|----------|
| `defaults` | Getting started, low-risk exploration |
| `agent` | Autonomous bots with business-hours discipline |
| `user` | Human traders delegating to an agent with strong guardrails |
| `conservative` | Experimentation, every mutation requires approval |

## Verify

After setup, ask your agent:

> Search Polymarket for election markets

The agent should use `markets_search` and return results. If it works, the MCP server is connected and the skill is active.
