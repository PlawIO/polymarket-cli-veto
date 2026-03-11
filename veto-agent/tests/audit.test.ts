import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLogger, type AuditEntry, type AuditConfig } from '../src/audit.js';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `test-${Date.now()}`,
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

describe('AuditLogger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'audit-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes JSONL entries to file', () => {
    const filePath = join(tempDir, 'data', 'audit.jsonl');
    const logger = new AuditLogger({ enabled: true, filePath, maxFileSizeMb: 50 });

    logger.log(makeEntry({ id: 'entry-1' }));
    logger.log(makeEntry({ id: 'entry-2' }));

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toHaveProperty('id', 'entry-1');
    expect(JSON.parse(lines[1]!)).toHaveProperty('id', 'entry-2');
  });

  it('does nothing when disabled', () => {
    const filePath = join(tempDir, 'audit.jsonl');
    const logger = new AuditLogger({ enabled: false, filePath, maxFileSizeMb: 50 });

    logger.log(makeEntry());
    expect(existsSync(filePath)).toBe(false);
  });

  it('queries with since filter', () => {
    const filePath = join(tempDir, 'audit.jsonl');
    const logger = new AuditLogger({ enabled: true, filePath, maxFileSizeMb: 50 });

    const old = makeEntry({ id: 'old', timestamp: '2025-01-01T00:00:00.000Z' });
    const recent = makeEntry({ id: 'recent', timestamp: '2026-03-01T00:00:00.000Z' });
    logger.log(old);
    logger.log(recent);

    const results = logger.query({ since: '2026-01-01T00:00:00.000Z' });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('recent');
  });

  it('queries with agentId and toolName filters', () => {
    const filePath = join(tempDir, 'audit.jsonl');
    const logger = new AuditLogger({ enabled: true, filePath, maxFileSizeMb: 50 });

    logger.log(makeEntry({ id: 'a1', agentId: 'agent-1', toolName: 'order_market' }));
    logger.log(makeEntry({ id: 'a2', agentId: 'agent-2', toolName: 'order_cancel' }));
    logger.log(makeEntry({ id: 'a3', agentId: 'agent-1', toolName: 'order_cancel' }));

    expect(logger.query({ agentId: 'agent-1' })).toHaveLength(2);
    expect(logger.query({ toolName: 'order_cancel' })).toHaveLength(2);
    expect(logger.query({ agentId: 'agent-1', toolName: 'order_cancel' })).toHaveLength(1);
  });

  it('queries with limit', () => {
    const filePath = join(tempDir, 'audit.jsonl');
    const logger = new AuditLogger({ enabled: true, filePath, maxFileSizeMb: 50 });

    for (let i = 0; i < 10; i++) {
      logger.log(makeEntry({ id: `entry-${i}` }));
    }

    const results = logger.query({ limit: 3 });
    expect(results).toHaveLength(3);
    expect(results[0]!.id).toBe('entry-7');
  });

  it('rotates file when size limit exceeded', () => {
    const filePath = join(tempDir, 'audit.jsonl');
    const logger = new AuditLogger({ enabled: true, filePath, maxFileSizeMb: 0.0001 });

    // Write enough data to exceed 100 bytes
    const bigEntry = makeEntry({ id: 'big', guardArgs: { data: 'x'.repeat(200) } });
    logger.log(bigEntry);

    // Original file should have been rotated, new entry in fresh file
    logger.log(makeEntry({ id: 'after-rotate' }));

    const content = readFileSync(filePath, 'utf-8').trim();
    const entries = content.split('\n').map((l) => JSON.parse(l) as AuditEntry);
    expect(entries[entries.length - 1]!.id).toBe('after-rotate');
  });

  it('fires webhook asynchronously without blocking', async () => {
    const filePath = join(tempDir, 'audit.jsonl');
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const logger = new AuditLogger({
      enabled: true,
      filePath,
      webhookUrl: 'https://hooks.example.com/audit',
      maxFileSizeMb: 50,
    });

    logger.log(makeEntry({ id: 'webhook-test' }));

    // Let the microtask queue flush
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example.com/audit',
      expect.objectContaining({ method: 'POST' }),
    );

    vi.unstubAllGlobals();
  });
});
