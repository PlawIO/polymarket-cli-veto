import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLogger, type AuditEntry, type AuditConfig } from '../src/audit.js';
import { ComplianceExporter } from '../src/compliance.js';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `test-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    sessionId: 'session-test',
    agentId: 'profile/defaults',
    toolName: 'order_market',
    guardArgs: { token: 'abc', side: 'buy', amount_usd: 10 },
    decision: 'allow',
    durationMs: 5,
    ...overrides,
  };
}

describe('ComplianceExporter', () => {
  let tempDir: string;
  let auditConfig: AuditConfig;
  let auditLogger: AuditLogger;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'compliance-test-'));
    auditConfig = { enabled: true, filePath: join(tempDir, 'audit.jsonl'), maxFileSizeMb: 50 };
    auditLogger = new AuditLogger(auditConfig);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates summary with correct aggregation', () => {
    auditLogger.log(makeEntry({ agentId: 'agent-1', toolName: 'order_market', decision: 'allow', guardArgs: { amount_usd: 100 } }));
    auditLogger.log(makeEntry({ agentId: 'agent-1', toolName: 'order_cancel', decision: 'allow', guardArgs: {} }));
    auditLogger.log(makeEntry({ agentId: 'agent-2', toolName: 'order_market', decision: 'deny', guardArgs: { amount_usd: 50 } }));

    const exporter = new ComplianceExporter(auditLogger);
    const outputPath = join(tempDir, 'report.json');
    const result = exporter.generateReport({
      format: 'json',
      period: 'day',
      outputPath,
    });

    expect(result.summary.totalTrades).toBe(3);
    expect(result.summary.totalVolumeUsd).toBe(150);
    expect(result.summary.tradesByAgent['agent-1']).toBe(2);
    expect(result.summary.tradesByAgent['agent-2']).toBe(1);
    expect(result.summary.tradesByTool['order_market']).toBe(2);
    expect(result.summary.decisions['allow']).toBe(2);
    expect(result.summary.decisions['deny']).toBe(1);
  });

  it('exports valid CSV', () => {
    auditLogger.log(makeEntry({ guardArgs: { token: 'abc', side: 'buy', amount_usd: 25 } }));

    const exporter = new ComplianceExporter(auditLogger);
    const outputPath = join(tempDir, 'report.csv');
    exporter.generateReport({ format: 'csv', period: 'day', outputPath });

    const csv = readFileSync(outputPath, 'utf-8');
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[0]).toContain('timestamp');
    expect(lines[0]).toContain('amount_usd');
    expect(lines[1]).toContain('25');
  });

  it('exports valid JSON with summary', () => {
    auditLogger.log(makeEntry());

    const exporter = new ComplianceExporter(auditLogger);
    const outputPath = join(tempDir, 'report.json');
    exporter.generateReport({ format: 'json', period: 'day', outputPath });

    const json = JSON.parse(readFileSync(outputPath, 'utf-8')) as { summary: { totalTrades: number }; entries: AuditEntry[] };
    expect(json.summary.totalTrades).toBe(1);
    expect(json.entries).toHaveLength(1);
  });

  it('filters by period', () => {
    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    auditLogger.log(makeEntry({ id: 'old', timestamp: oldTimestamp }));
    auditLogger.log(makeEntry({ id: 'recent', timestamp: new Date().toISOString() }));

    const exporter = new ComplianceExporter(auditLogger);
    const outputPath = join(tempDir, 'report.json');
    const result = exporter.generateReport({ format: 'json', period: 'day', outputPath });

    expect(result.summary.totalTrades).toBe(1);
  });

  it('filters by custom date range', () => {
    auditLogger.log(makeEntry({ timestamp: '2026-01-15T12:00:00.000Z' }));
    auditLogger.log(makeEntry({ timestamp: '2026-02-15T12:00:00.000Z' }));
    auditLogger.log(makeEntry({ timestamp: '2026-03-15T12:00:00.000Z' }));

    const exporter = new ComplianceExporter(auditLogger);
    const outputPath = join(tempDir, 'report.json');
    const result = exporter.generateReport({
      format: 'json',
      startDate: '2026-02-01T00:00:00.000Z',
      endDate: '2026-02-28T23:59:59.000Z',
      outputPath,
    });

    expect(result.summary.totalTrades).toBe(1);
  });

  it('handles empty audit log', () => {
    const exporter = new ComplianceExporter(auditLogger);
    const outputPath = join(tempDir, 'report.json');
    const result = exporter.generateReport({ format: 'json', period: 'day', outputPath });

    expect(result.summary.totalTrades).toBe(0);
    expect(result.summary.totalVolumeUsd).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
  });

  it('creates output directories recursively', () => {
    auditLogger.log(makeEntry());

    const exporter = new ComplianceExporter(auditLogger);
    const outputPath = join(tempDir, 'deep', 'nested', 'dir', 'report.csv');
    exporter.generateReport({ format: 'csv', period: 'day', outputPath });

    expect(existsSync(outputPath)).toBe(true);
  });
});
