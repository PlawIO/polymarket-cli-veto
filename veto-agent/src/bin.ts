#!/usr/bin/env node

import { loadConfig, toJsonSafeConfig } from './config.js';
import { serveSse, serveStdio } from './mcp.js';
import { PolymarketVetoRuntime } from './runtime.js';
import { POLICY_PROFILES, type McpTransport, type PolicyProfile } from './types.js';
import { AuditLogger } from './audit.js';
import { ComplianceExporter } from './compliance.js';

interface ParsedArgs {
  command: string;
  flags: Record<string, boolean>;
  values: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  let command = '';

  const valueFlags = new Set(['config', 'policy-profile', 'simulation', 'transport', 'host', 'port', 'format', 'period', 'start', 'end', 'output']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token.startsWith('--')) {
      const name = token.slice(2);
      if (valueFlags.has(name) && i + 1 < argv.length) {
        values[name] = argv[++i] ?? '';
      } else {
        flags[name] = true;
      }
      continue;
    }

    if (!command) {
      command = token;
      continue;
    }
  }

  return {
    command,
    flags,
    values,
  };
}

function parsePolicyProfile(value: string | undefined): PolicyProfile | undefined {
  if (!value) return undefined;
  if (POLICY_PROFILES.includes(value as PolicyProfile)) return value as PolicyProfile;
  throw new Error(`Invalid --policy-profile value. Expected ${POLICY_PROFILES.join('|')}.`);
}

function parseSimulation(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error("Invalid --simulation value. Expected on|off.");
}

function parseTransport(value: string | undefined): McpTransport | undefined {
  if (!value) return undefined;
  if (value === 'stdio' || value === 'sse') return value;
  throw new Error("Invalid --transport value. Expected stdio|sse.");
}

function printHelp(): void {
  console.log(`
polymarket-veto-mcp

Usage:
  polymarket-veto-mcp serve [--config <path>] [--policy-profile ${POLICY_PROFILES.join('|')}] [--simulation on|off] [--transport stdio|sse]
  polymarket-veto-mcp doctor [--config <path>]
  polymarket-veto-mcp print-config [--config <path>]
  polymarket-veto-mcp print-tools [--config <path>]
  polymarket-veto-mcp export [--format csv|json] [--period day|week|month] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--output path]
`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.command || 'serve';

  if (parsed.flags.help || command === 'help') {
    printHelp();
    return;
  }

  const resolved = loadConfig(parsed.values.config);
  const profile = parsePolicyProfile(parsed.values['policy-profile']);
  const simulationOverride = parseSimulation(parsed.values.simulation);
  const transportOverride = parseTransport(parsed.values.transport);

  if (profile) {
    resolved.config.veto.policyProfile = profile;
  }

  if (transportOverride) {
    resolved.config.mcp.transport = transportOverride;
  }

  if (parsed.values.host) {
    resolved.config.mcp.host = parsed.values.host;
  }

  if (parsed.values.port) {
    const parsedPort = Number.parseInt(parsed.values.port, 10);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      throw new Error('Invalid --port value');
    }
    resolved.config.mcp.port = parsedPort;
  }

  if (command === 'print-config') {
    console.log(JSON.stringify({
      configPath: resolved.path,
      source: resolved.source,
      config: toJsonSafeConfig(resolved.config),
    }, null, 2));
    return;
  }

  if (command === 'export') {
    const format = parsed.values.format === 'csv' ? 'csv' : 'json';
    const period = parsed.values.period as 'day' | 'week' | 'month' | undefined;
    const outputPath = parsed.values.output ?? `./data/reports/report-${Date.now()}.${format}`;

    const auditLogger = new AuditLogger(resolved.config.audit);
    const exporter = new ComplianceExporter(auditLogger);

    const report = exporter.generateReport({
      format,
      period,
      startDate: parsed.values.start,
      endDate: parsed.values.end,
      outputPath,
    });

    console.log(JSON.stringify({
      outputPath: report.outputPath,
      summary: report.summary,
    }, null, 2));
    return;
  }

  const runtime = await PolymarketVetoRuntime.create(resolved);

  if (command === 'print-tools') {
    console.log(JSON.stringify({
      tools: runtime.listMcpTools(),
    }, null, 2));
    return;
  }

  if (command === 'doctor') {
    const report = await runtime.doctor();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok === true ? 0 : 1;
    return;
  }

  if (command !== 'serve') {
    throw new Error(`Unknown command '${command}'`);
  }

  const startup = runtime.getStartupInfo();
  process.stderr.write(`Polymarket Veto MCP | profile=${String(startup.profile)} | transport=${String(startup.transport)}\n`);
  process.stderr.write(`Simulation default=${String(startup.simulationDefault)} | liveAllowed=${String(startup.allowLiveTrades)}\n`);
  if (startup.binaryAvailable === true) {
    process.stderr.write(`Polymarket binary=${String(startup.binaryResolvedPath)} (source=${String(startup.binarySource)})\n`);
  } else {
    process.stderr.write("Polymarket binary unavailable. Run 'polymarket-veto-mcp doctor' for setup help.\n");
  }

  if (resolved.config.mcp.transport === 'sse') {
    await serveSse(runtime, { simulationOverride });
    return;
  }

  await serveStdio(runtime, { simulationOverride });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
