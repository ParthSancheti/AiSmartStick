import { describe, expect, it } from 'vitest';
import { localNetworkBlockMessage } from '../src/core/transport/connectionError';

describe('local network permission failures', () => {
  it('explains the observed Android binding refusal without blaming the camera', () => {
    expect(localNetworkBlockMessage(new Error('Native request failed: Setup request failed: Binding socket to network 133 failed: EPERM (Operation not permitted)'))).toContain('Check VPN');
  });
  it.each(['camera: busy', 'HTTP 403 PERMISSION_DENIED', 'not bound to the stick network', 'failed to connect: timeout'])('does not mislabel %s as a VPN problem', error => {
    expect(localNetworkBlockMessage(new Error(error))).toBeNull();
  });
});
