import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditLogger, AuditEntry } from './audit.js';

export interface ReportConfig {
  format: 'csv' | 'json';
  period?: 'day' | 'week' | 'month';
  startDate?: string;
  endDate?: string;
  outputPath: string;
}

export interface ReportSummary {
  totalTrades: number;
  totalVolumeUsd: number;
  tradesByAgent: Record<string, number>;
  tradesByTool: Record<string, number>;
  decisions: Record<string, number>;
  period: { start: string; end: string };
}

export class ComplianceExporter {
  constructor(private readonly auditLogger: AuditLogger) {}

  generateReport(config: ReportConfig): { summary: ReportSummary; outputPath: string } {
    const { start, end } = this.resolvePeriod(config);
    const entries = this.auditLogger.query({ since: start });
    const filtered = entries.filter((e) => e.timestamp >= start && e.timestamp <= end);
    const summary = this.aggregate(filtered, start, end);

    mkdirSync(dirname(config.outputPath), { recursive: true });

    if (config.format === 'csv') {
      this.exportCsv(filtered, config.outputPath);
    } else {
      this.exportJson(filtered, summary, config.outputPath);
    }

    return { summary, outputPath: config.outputPath };
  }

  private aggregate(entries: AuditEntry[], start: string, end: string): ReportSummary {
    const tradesByAgent: Record<string, number> = {};
    const tradesByTool: Record<string, number> = {};
    const decisions: Record<string, number> = {};
    let totalVolumeUsd = 0;

    for (const entry of entries) {
      tradesByAgent[entry.agentId] = (tradesByAgent[entry.agentId] ?? 0) + 1;
      tradesByTool[entry.toolName] = (tradesByTool[entry.toolName] ?? 0) + 1;
      decisions[entry.decision] = (decisions[entry.decision] ?? 0) + 1;

      const amount = entry.guardArgs.amount_usd;
      if (typeof amount === 'number') {
        totalVolumeUsd += amount;
      }
    }

    return {
      totalTrades: entries.length,
      totalVolumeUsd,
      tradesByAgent,
      tradesByTool,
      decisions,
      period: { start, end },
    };
  }

  private exportCsv(entries: AuditEntry[], outputPath: string): void {
    const headers = [
      'timestamp',
      'session_id',
      'agent_id',
      'tool_name',
      'decision',
      'amount_usd',
      'token',
      'side',
      'rule_id',
      'reason',
      'execution_ok',
      'simulation',
      'duration_ms',
    ];

    const rows = entries.map((e) => [
      e.timestamp,
      e.sessionId,
      e.agentId,
      e.toolName,
      e.decision,
      String(typeof e.guardArgs.amount_usd === 'number' ? e.guardArgs.amount_usd : ''),
      String(e.guardArgs.token ?? ''),
      String(e.guardArgs.side ?? ''),
      e.ruleId ?? '',
      (e.reason ?? '').replace(/"/g, '""'),
      e.executionResult?.ok != null ? String(e.executionResult.ok) : '',
      e.executionResult?.simulation != null ? String(e.executionResult.simulation) : '',
      String(e.durationMs),
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.map((v) => `"${v}"`).join(','))].join(
      '\n',
    );

    writeFileSync(outputPath, csv, 'utf-8');
  }

  private exportJson(
    entries: AuditEntry[],
    summary: ReportSummary,
    outputPath: string,
  ): void {
    writeFileSync(outputPath, JSON.stringify({ summary, entries }, null, 2), 'utf-8');
  }

  private resolvePeriod(config: ReportConfig): { start: string; end: string } {
    const now = new Date();
    const end = config.endDate ?? now.toISOString();

    if (config.startDate) {
      return { start: config.startDate, end };
    }

    const start = new Date(now);
    switch (config.period) {
      case 'week':
        start.setDate(start.getDate() - 7);
        break;
      case 'month':
        start.setMonth(start.getMonth() - 1);
        break;
      default:
        start.setDate(start.getDate() - 1);
        break;
    }

    return { start: start.toISOString(), end };
  }
}
