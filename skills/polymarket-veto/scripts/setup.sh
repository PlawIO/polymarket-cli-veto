#!/bin/bash
set -e

# Polymarket Veto MCP — setup script
# Configures the MCP server in the current project's .mcp.json
#
# Usage:
#   bash setup.sh [profile]
#
# Profiles: defaults, agent, user, conservative
# Default: defaults

PROFILE="${1:-defaults}"

VALID_PROFILES="defaults agent user conservative"
if ! echo "$VALID_PROFILES" | grep -qw "$PROFILE"; then
  echo "Error: invalid profile '$PROFILE'" >&2
  echo "Valid profiles: $VALID_PROFILES" >&2
  exit 1
fi

# Check for polymarket binary
if command -v polymarket &>/dev/null; then
  POLY_VERSION=$(polymarket --version 2>/dev/null || echo "unknown")
  echo "Polymarket CLI found: $POLY_VERSION" >&2
else
  echo "Warning: polymarket binary not found in PATH" >&2
  echo "Install it: brew install polymarket" >&2
  echo "Or build from source: cargo build --release" >&2
  echo "" >&2
  echo "The MCP server will be configured but won't work until the binary is available." >&2
fi

# Check for existing .mcp.json
MCP_CONFIG=".mcp.json"

if [ -f "$MCP_CONFIG" ]; then
  # Check if polymarket-veto is already configured
  if grep -q '"polymarket-veto"' "$MCP_CONFIG" 2>/dev/null; then
    echo "polymarket-veto already configured in $MCP_CONFIG" >&2
    echo "To change profile, edit the --policy-profile value in $MCP_CONFIG" >&2
    exit 0
  fi

  echo "Existing $MCP_CONFIG found, adding polymarket-veto server..." >&2

  # Use node to merge JSON (handles edge cases better than sed)
  node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('$MCP_CONFIG', 'utf8'));
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers['polymarket-veto'] = {
      command: 'npm',
      args: [
        'exec', '--yes', '--prefix', '/tmp',
        '--package', '@plawio/polymarket-veto-mcp',
        '--', 'polymarket-veto-mcp', 'serve',
        '--policy-profile', '$PROFILE'
      ]
    };
    fs.writeFileSync('$MCP_CONFIG', JSON.stringify(config, null, 2) + '\n');
  "
else
  echo "Creating $MCP_CONFIG with polymarket-veto server..." >&2

  cat > "$MCP_CONFIG" << MCPEOF
{
  "mcpServers": {
    "polymarket-veto": {
      "command": "npm",
      "args": [
        "exec", "--yes", "--prefix", "/tmp",
        "--package", "@plawio/polymarket-veto-mcp",
        "--", "polymarket-veto-mcp", "serve",
        "--policy-profile", "$PROFILE"
      ]
    }
  }
}
MCPEOF
fi

echo "" >&2
echo "MCP server configured:" >&2
echo "  Profile: $PROFILE" >&2
echo "  Config:  $MCP_CONFIG" >&2
echo "" >&2
echo "Restart Claude Code to pick up the new MCP server." >&2

# Machine-readable output
cat << JSONEOF
{
  "status": "configured",
  "profile": "$PROFILE",
  "configPath": "$MCP_CONFIG"
}
JSONEOF
