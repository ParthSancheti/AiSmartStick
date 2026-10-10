import type { LinkState } from '../types';

export function linkLabelText(l: LinkState) {
  return l === 'connected' ? 'connected' : l === 'degraded' ? 'connected (weak link)' : l === 'protocol_mismatch' ? 'needs a firmware update' : l === 'reconnecting' ? 'reconnecting' : l === 'searching' || l === 'connecting' ? 'connecting' : l === 'auth_failed' ? 'needs a firmware update' : 'disconnected';
}
