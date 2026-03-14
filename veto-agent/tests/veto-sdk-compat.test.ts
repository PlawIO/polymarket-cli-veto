import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Veto } from 'veto-sdk';

const tempDirs: string[] = [];

function createFixture(): string {
  const baseDir = mkdtempSync(join(tmpdir(), 'veto-sdk-compat-'));
  tempDirs.push(baseDir);
  mkdirSync(join(baseDir, 'veto', 'rules'), { recursive: true });
  writeFileSync(
    join(baseDir, 'veto', 'veto.config.yaml'),
    [
      'version: "1.0"',
      'mode: strict',
      'validation:',
      '  mode: local',
      'rules:',
      '  directory: ./rules',
    ].join('\n'),
    'utf-8'
  );
  return baseDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('veto-sdk compatibility', () => {
  it('supports runtime budget context in guard calls', async () => {
    const baseDir = createFixture();

    writeFileSync(
      join(baseDir, 'veto', 'rules', 'budget.yaml'),
      [
        'version: "1.0"',
        'name: budget-rules',
        'rules:',
        '  - id: budget-block',
        '    name: Budget Block',
        '    enabled: true',
        '    action: block',
        '    tools: [trade]',
        '    conditions:',
        '      - field: budget.remaining',
        '        operator: less_than',
        '        value: 100',
      ].join('\n'),
      'utf-8'
    );

    const veto = await Veto.init({
      configDir: join(baseDir, 'veto'),
      logLevel: 'silent',
    });

    const result = await veto.guard(
      'trade',
      { amount_usd: 40 },
      {
        sessionId: 'session-test',
        budget: { remaining: 80 },
      } as never
    );

    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('budget-block');
  });

  it('reloads local rules for runtime policy overlays', async () => {
    const baseDir = createFixture();
    const veto = await Veto.init({
      configDir: join(baseDir, 'veto'),
      logLevel: 'silent',
    });
    const reloadableVeto = veto as Veto & {
      reloadLocalRules?: () => Promise<void>;
    };

    const before = await veto.guard('trade', { amount_usd: 150 }, { sessionId: 'session-test' });
    expect(before.decision).toBe('allow');
    expect(typeof reloadableVeto.reloadLocalRules).toBe('function');

    writeFileSync(
      join(baseDir, 'veto', 'rules', 'dynamic.yaml'),
      [
        'version: "1.0"',
        'name: dynamic-rules',
        'rules:',
        '  - id: dynamic-block',
        '    name: Dynamic Block',
        '    enabled: true',
        '    action: block',
        '    tools: [trade]',
        '    conditions:',
        '      - field: arguments.amount_usd',
        '        operator: greater_than',
        '        value: 100',
      ].join('\n'),
      'utf-8'
    );

    await reloadableVeto.reloadLocalRules?.();
    const after = await veto.guard('trade', { amount_usd: 150 }, { sessionId: 'session-test' });

    expect(after.decision).toBe('deny');
    expect(after.ruleId).toBe('dynamic-block');
  });
});
