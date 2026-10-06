import { useUI } from './store/ui';
import { logEvent } from './store/activity';
import { useSession, getSettings } from './store/session';
import { isDemo } from './runtime/mode';
import { AissNative, type CallResult, type SmsResult } from './native/aissNative';

/**
 * Calls and SMS. Real mode uses Android: a direct call when CALL_PHONE is granted, otherwise
 * the dialer with the number filled in. Results are reported truthfully: "dialer opened" is
 * not "call placed", "composer opened" is not "sent". Demo mode shows the in-app call screen.
 */
export async function placeCall(name: string, number: string | null): Promise<CallResult | 'demo' | 'no_number'> {
  const person = useSession.getState().person.name || 'User';
  if (isDemo()) {
    useUI.setState({ call: { name, startedAt: Date.now() } });
    logEvent({ kind: 'message', severity: 'info', title: `${person} called ${name}`, detail: 'Demo call screen' });
    return 'demo';
  }
  if (!number) return 'no_number';
  const { result } = await AissNative.placeCall({ number, direct: getSettings().callMode === 'direct' });
  logEvent({ kind: 'message', severity: 'info', title: result === 'call_started' ? `Called ${name}` : `Opened the dialer for ${name}` });
  return result;
}

export async function sendSms(name: string, number: string | null, body: string, opts: { direct?: boolean } = {}): Promise<SmsResult | 'demo' | 'no_number'> {
  if (isDemo()) {
    logEvent({ kind: 'message', severity: 'info', title: `Message to ${name}`, detail: `${body} (demo, not sent)` });
    return 'demo';
  }
  if (!number) return 'no_number';
  // direct = send without a tap when SEND_SMS is granted; the plugin falls back to the composer truthfully.
  const { result } = await AissNative.sendSms({ number, body, direct: opts.direct ?? getSettings().smsMode === 'direct' });
  logEvent({ kind: 'message', severity: 'info', title: result === 'sent' ? `Text sent to ${name}` : `Opened a text to ${name}`, detail: body });
  return result;
}

/** Demo call screen only. */
export function startCall(name: string) {
  useUI.setState({ call: { name, startedAt: Date.now() } });
}

export function endCall() {
  useUI.setState({ call: null });
}
