/** Android can refuse binding to local Wi-Fi when VPN bypass/lockdown policy blocks it. */
export function localNetworkBlockMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /binding socket to network.*(?:EPERM|operation not permitted)/i.test(message)
    ? 'Android blocked the stick Wi-Fi connection. Check VPN local-network access or pause the VPN, then reconnect.'
    : null;
}
