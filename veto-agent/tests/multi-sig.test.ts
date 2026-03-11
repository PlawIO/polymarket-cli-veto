import { describe, expect, it } from 'vitest';
import { MultiSigManager, type MultiSigConfig } from '../src/multi-sig.js';

function makeConfig(overrides: Partial<MultiSigConfig> = {}): MultiSigConfig {
  return {
    enabled: true,
    minApprovals: 2,
    thresholdUsd: 100,
    approvalTimeoutMs: 600_000,
    ...overrides,
  };
}

describe('MultiSigManager', () => {
  it('requires multi-sig only above threshold', () => {
    const mgr = new MultiSigManager(makeConfig());

    expect(mgr.needsMultiSig(50)).toBe(false);
    expect(mgr.needsMultiSig(100)).toBe(false);
    expect(mgr.needsMultiSig(101)).toBe(true);
  });

  it('does not require multi-sig when disabled', () => {
    const mgr = new MultiSigManager(makeConfig({ enabled: false }));
    expect(mgr.needsMultiSig(1000)).toBe(false);
  });

  it('tracks approval count', () => {
    const mgr = new MultiSigManager(makeConfig({ minApprovals: 3 }));

    mgr.recordApproval('apr-1', 'reviewer-a');
    expect(mgr.getApprovalCount('apr-1')).toBe(1);
    expect(mgr.isFullyApproved('apr-1')).toBe(false);

    mgr.recordApproval('apr-1', 'reviewer-b');
    expect(mgr.getApprovalCount('apr-1')).toBe(2);
    expect(mgr.isFullyApproved('apr-1')).toBe(false);

    mgr.recordApproval('apr-1', 'reviewer-c');
    expect(mgr.getApprovalCount('apr-1')).toBe(3);
    expect(mgr.isFullyApproved('apr-1')).toBe(true);
  });

  it('deduplicates same approver', () => {
    const mgr = new MultiSigManager(makeConfig());

    mgr.recordApproval('apr-1', 'reviewer-a');
    mgr.recordApproval('apr-1', 'reviewer-a');
    expect(mgr.getApprovalCount('apr-1')).toBe(1);
  });

  it('fully approved with minApprovals reached', () => {
    const mgr = new MultiSigManager(makeConfig({ minApprovals: 2 }));

    mgr.recordApproval('apr-1', 'reviewer-a');
    mgr.recordApproval('apr-1', 'reviewer-b');
    expect(mgr.isFullyApproved('apr-1')).toBe(true);

    expect(mgr.getRequiredApprovals()).toBe(2);
  });
});
