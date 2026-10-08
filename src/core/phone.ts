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

/** How long an SOS waits on Android's SMS permission dialog before sending anyway (composer fallback). */
export const SOS_SMS_PERMISSION_WAIT_MS = 5000;

/**
 * `permissionWaitMs` (SOS): never wait longer than this for the SMS permission dialog. A blind user
 * may not see it; the plugin then opens the Messages app with the text instead of waiting forever.
 */
export async function sendSms(name: string, number: string | null, body: string, opts: { direct?: boolean; permissionWaitMs?: number } = {}): Promise<SmsResult | 'demo' | 'no_number'> {
  if (isDemo()) {
    logEvent({ kind: 'message', severity: 'info', title: `Message to ${name}`, detail: `${body} (demo, not sent)` });
    return 'demo';
  }
  if (!number) return 'no_number';
  // direct = send without a tap when SEND_SMS is granted; the plugin falls back to the composer truthfully.
  const direct = opts.direct ?? getSettings().smsMode === 'direct';
  // Sending without a tap needs Android's SMS permission: ask for it right here if it is missing
  // (a no-op when already granted), otherwise Android only lets the app open the Messages app.
  if (direct) {
    const ask = AissNative.requestPermissions({ permissions: ['sms'] }).catch(() => undefined);
    if (opts.permissionWaitMs == null) await ask;
    else {
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([ask, new Promise((r) => (t = setTimeout(r, opts.permissionWaitMs)))]);
      clearTimeout(t);
    }
  }
  let { result, error } = await AissNative.sendSms({ number, body, direct });
  if (result === 'failed' && direct) {
    // The radio refused it (no signal, no balance): the Messages app can still retry it.
    logEvent({ kind: 'message', severity: 'warning', title: `Text to ${name} failed`, detail: error ?? 'SMS failed' });
    ({ result, error } = await AissNative.sendSms({ number, body, direct: false }));
  }
  const title = result === 'sent' ? `Text sent to ${name}` : result === 'queued' ? `Sending a text to ${name}` : result === 'composer_opened' ? `Opened a text to ${name}` : `Could not text ${name}`;
  logEvent({ kind: 'message', severity: result === 'failed' ? 'warning' : 'info', title, detail: error ? `${body} (${error})` : body });
  return result;
}

/** Demo call screen only. */
export function startCall(name: string) {
  useUI.setState({ call: { name, startedAt: Date.now() } });
}

export function endCall() {
  useUI.setState({ call: null });
}
