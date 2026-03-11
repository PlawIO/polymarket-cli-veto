import { createHmac, timingSafeEqual } from 'node:crypto';

export interface IdentityConfig {
  enabled: boolean;
  algorithm: 'sha256' | 'sha512';
  agents: Array<{ agentId: string; secretEnv: string }>;
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

export class AgentIdentity {
  constructor(private readonly config: IdentityConfig) {}

  sign(agentId: string, payload: Record<string, unknown>): string {
    const secret = this.getAgentKey(agentId);
    if (!secret) {
      throw new Error(`No secret configured for agent '${agentId}'`);
    }
    return createHmac(this.config.algorithm, secret)
      .update(JSON.stringify(sortKeys(payload)))
      .digest('hex');
  }

  verify(agentId: string, payload: Record<string, unknown>, signature: string): boolean {
    const secret = this.getAgentKey(agentId);
    if (!secret) return false;

    const expected = createHmac(this.config.algorithm, secret)
      .update(JSON.stringify(sortKeys(payload)))
      .digest('hex');

    if (expected.length !== signature.length) return false;

    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  }

  getAgentKey(agentId: string): string | undefined {
    const agent = this.config.agents.find((a) => a.agentId === agentId);
    if (!agent) return undefined;
    const key = process.env[agent.secretEnv];
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  }
}
