export interface MultiSigConfig {
  enabled: boolean;
  minApprovals: number;
  thresholdUsd: number;
  approvalTimeoutMs: number;
}

interface ApprovalRecord {
  approvedBy: string;
  at: string;
}

export class MultiSigManager {
  private approvals = new Map<string, ApprovalRecord[]>();

  constructor(private readonly config: MultiSigConfig) {}

  needsMultiSig(amountUsd: number): boolean {
    return this.config.enabled && amountUsd > this.config.thresholdUsd;
  }

  recordApproval(approvalId: string, approvedBy: string): ApprovalRecord[] {
    const existing = this.approvals.get(approvalId) ?? [];
    if (!existing.some((a) => a.approvedBy === approvedBy)) {
      existing.push({ approvedBy, at: new Date().toISOString() });
      this.approvals.set(approvalId, existing);
    }
    return existing;
  }

  isFullyApproved(approvalId: string): boolean {
    const records = this.approvals.get(approvalId) ?? [];
    return records.length >= this.config.minApprovals;
  }

  getApprovalCount(approvalId: string): number {
    return (this.approvals.get(approvalId) ?? []).length;
  }

  getRequiredApprovals(): number {
    return this.config.minApprovals;
  }
}
