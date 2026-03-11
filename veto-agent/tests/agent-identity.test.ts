import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { AgentIdentity, type IdentityConfig } from '../src/agent-identity.js';

function makeConfig(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    enabled: true,
    algorithm: 'sha256',
    agents: [
      { agentId: 'agent-1', secretEnv: 'TEST_AGENT_SECRET' },
    ],
    ...overrides,
  };
}

describe('AgentIdentity', () => {
  const secret = 'test-hmac-secret-key-123';

  beforeEach(() => {
    process.env.TEST_AGENT_SECRET = secret;
  });

  afterEach(() => {
    delete process.env.TEST_AGENT_SECRET;
  });

  it('produces deterministic signatures', () => {
    const identity = new AgentIdentity(makeConfig());
    const payload = { token: 'abc', side: 'buy', amount: 10 };

    const sig1 = identity.sign('agent-1', payload);
    const sig2 = identity.sign('agent-1', payload);
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different payloads', () => {
    const identity = new AgentIdentity(makeConfig());

    const sig1 = identity.sign('agent-1', { token: 'abc' });
    const sig2 = identity.sign('agent-1', { token: 'def' });
    expect(sig1).not.toBe(sig2);
  });

  it('verifies valid signatures', () => {
    const identity = new AgentIdentity(makeConfig());
    const payload = { token: 'abc', side: 'buy' };
    const sig = identity.sign('agent-1', payload);

    expect(identity.verify('agent-1', payload, sig)).toBe(true);
  });

  it('rejects tampered payloads', () => {
    const identity = new AgentIdentity(makeConfig());
    const payload = { token: 'abc', side: 'buy' };
    const sig = identity.sign('agent-1', payload);

    expect(identity.verify('agent-1', { token: 'abc', side: 'sell' }, sig)).toBe(false);
  });

  it('rejects unknown agents', () => {
    const identity = new AgentIdentity(makeConfig());

    expect(() => identity.sign('unknown-agent', { test: true })).toThrow('No secret configured');
    expect(identity.verify('unknown-agent', { test: true }, 'abc')).toBe(false);
  });

  it('handles missing env var', () => {
    delete process.env.TEST_AGENT_SECRET;
    const identity = new AgentIdentity(makeConfig());

    expect(() => identity.sign('agent-1', { test: true })).toThrow('No secret configured');
  });
});
