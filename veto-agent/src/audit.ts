import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditEntry {
  id: string;
  timestamp: string;
  sessionId: string;
  agentId: string;
  toolName: string;
  guardArgs: Record<string, unknown>;
  decision: string;
  reason?: string;
  ruleId?: string;
  executionResult?: {
    ok: boolean;
    exitCode?: number;
    simulation: boolean;
  };
  durationMs: number;
}

export interface AuditConfig {
  enabled: boolean;
  filePath: string;
  webhookUrl?: string;
  maxFileSizeMb: number;
}

export class AuditLogger {
  private initialized = false;

  constructor(private readonly config: AuditConfig) {}

  log(entry: AuditEntry): void {
    if (!this.config.enabled) return;

    try {
      this.ensureDir();
      this.rotateIfNeeded();
      appendFileSync(this.config.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Never block trades on audit failure
    }

    this.logAsync(entry);
  }

  query(filters: { since?: string; agentId?: string; toolName?: string; limit?: number }): AuditEntry[] {
    if (!existsSync(this.config.filePath)) return [];

    let content: string;
    try {
      content = readFileSync(this.config.filePath, 'utf-8');
    } catch {
      return [];
    }

    const lines = content.split('\n').filter((l) => l.trim());
    let entries: AuditEntry[] = [];

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip malformed lines
      }
    }

    if (filters.since) {
      const since = filters.since;
      entries = entries.filter((e) => e.timestamp >= since);
    }
    if (filters.agentId) {
      const agentId = filters.agentId;
      entries = entries.filter((e) => e.agentId === agentId);
    }
    if (filters.toolName) {
      const toolName = filters.toolName;
      entries = entries.filter((e) => e.toolName === toolName);
    }
    if (filters.limit && filters.limit > 0) {
      entries = entries.slice(-filters.limit);
    }

    return entries;
  }

  private logAsync(entry: AuditEntry): void {
    if (!this.config.webhookUrl) return;

    fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }).catch(() => {});
  }

  private ensureDir(): void {
    if (this.initialized) return;
    mkdirSync(dirname(this.config.filePath), { recursive: true });
    this.initialized = true;
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.config.filePath)) return;

    try {
      const stats = statSync(this.config.filePath);
      const sizeMb = stats.size / (1024 * 1024);

      if (sizeMb >= this.config.maxFileSizeMb) {
        const rotatedPath = this.config.filePath.replace(/\.jsonl$/, `-${Date.now()}.jsonl`);
        renameSync(this.config.filePath, rotatedPath);
      }
    } catch {
      // Continue without rotation
    }
  }
}
