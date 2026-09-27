import type { SosTrigger } from '../types';
import { useSafety, initialSafety } from '../store/safety';
import { useSession, getSettings } from '../store/session';
import { useDevice } from '../store/device';
import { useUI, toastGuardian } from '../store/ui';
import { logEvent } from '../store/activity';
import { announce } from '../ai/voiceOut';
import { P } from '../ai/phrases';
import { haptics } from '../feedback/haptics';
import { earcon } from '../feedback/earcons';
import { stopSpeaking } from '../feedback/speech';
import { abortRecognition } from '../voice/recognition';
import { useAssistant } from '../store/assistant';
import { userSurfaceActive } from '../surfaces';
import { isDemo } from '../runtime/mode';
import { createSosEvent, stopSosWatch, updateSosEvent } from '../sync/userSync';
import { sendSms } from '../phone';
import { useLocation } from '../location/locationService';

let countTimer: ReturnType<typeof setInterval> | undefined;
let resetTimer: ReturnType<typeof setTimeout> | undefined;

const TRIGGER_LABEL: Record<SosTrigger, string> = {
  button: 'Button held for 3 seconds',
  voice: 'Asked for help by voice',
  fall: 'Fall detected by the stick',
};

const userFx = (fn: () => void) => {
  if (userSurfaceActive()) fn();
};

const alertNames = () => {
  const g = useSession.getState().guardian;
  return g.heardAs || g.name || 'your guardian';
};

export function startSos(trigger: SosTrigger) {
  const s = useSafety.getState();
  if (s.phase === 'countdown' || s.phase === 'active') return;
  clearTimeout(resetTimer);
  abortRecognition();
  stopSpeaking();
  useAssistant.setState({ phase: 'idle', heard: '' });
  const secs = getSettings().sosCancelSec;
  useSafety.setState({ ...initialSafety, phase: 'countdown', trigger, countdown: secs, startedAt: Date.now() });
  useUI.setState({ pocket: false, call: null });
  announce(P.sosIntro(trigger, secs), { high: true });
  userFx(() => {
    haptics.play('sos');
    earcon('alert');
  });
  if (trigger === 'fall') logEvent({ kind: 'safety', severity: 'warning', title: 'Fall detected', detail: 'Countdown started on the stick user’s phone' });

  clearInterval(countTimer);
  countTimer = setInterval(() => {
    const c = useSafety.getState().countdown - 1;
    if (c <= 0) {
      clearInterval(countTimer);
      activate();
      return;
    }
    useSafety.setState({ countdown: c });
    userFx(() => {
      haptics.play('countdown');
      earcon('tick');
    });
    if (c <= 2) announce(String(c), { high: true });
  }, 1000);
}

let currentSosId: string | null = null;

function activate() {
  const trigger = useSafety.getState().trigger ?? 'button';
  if (isDemo()) {
    const online = useDevice.getState().internet !== false;
    useSafety.setState({ phase: 'active', delivery: online ? 'cloud' : 'sms', countdown: 0 });
    userFx(() => {
      haptics.play('sos');
      earcon('sent');
    });
    announce(online ? P.sosSent(alertNames()) : P.sosSms, { high: true });
    logEvent({ kind: 'safety', severity: 'critical', title: 'SOS sent', detail: `${TRIGGER_LABEL[trigger]} (demo)` });
    return;
  }
  void activateReal(trigger);
}

/**
 * REAL SOS: persist to Firestore (Cloud Function pushes FCM to the guardian), share location,
 * and if the cloud can't be reached quickly, fall back to SMS to the guardian's real number.
 * The UI reports what actually happened: "delivered", "queued", "SMS sent" or "SMS composer opened".
 */
async function activateReal(trigger: SosTrigger) {
  const sosId = `sos_${Date.now()}`;
  currentSosId = sosId;
  useSafety.setState({ phase: 'active', delivery: 'pending', countdown: 0, guardianNotify: null, dispatchFailed: false });
  userFx(() => {
    haptics.play('sos');
    earcon('sent');
  });
  const loc = useLocation.getState().fix;
  logEvent({ kind: 'safety', severity: 'critical', title: 'SOS sent', detail: `${TRIGGER_LABEL[trigger]}${loc ? '' : '. Location was not available'}` });
  const result = await createSosEvent(sosId, trigger);
  if (result === 'synced') {
    useSafety.setState({ delivery: 'cloud' });
    announce(P.sosSent(alertNames()), { high: true });
    return;
  }
  // Cloud not confirmed: the write stays queued (Firestore offline cache) AND we try SMS now.
  const g = useSession.getState().guardian;
  const where = loc ? ` Location: https://maps.google.com/?q=${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}` : '';
  const body = `${getSettings().sosMessage}${where}`;
  try {
    const r = await sendSms(g.heardAs || g.name || 'Guardian', g.phone, body);
    if (r === 'sent') {
      useSafety.setState({ delivery: 'sms' });
      announce(P.sosSms, { high: true });
      void updateSosEvent(sosId, { smsFallback: 'sent' });
    } else if (r === 'composer_opened') {
      useSafety.setState({ delivery: 'sms' });
      announce({ en: 'No internet. I opened a text message to your guardian. Press send to deliver it.', hi: 'इंटरनेट नहीं है। गार्डियन के लिए मैसेज खोला है, भेजने के लिए सेंड दबाइए।' }, { high: true });
      void updateSosEvent(sosId, { smsFallback: 'composer_opened' });
    } else {
      announce({ en: 'No internet and no guardian phone number saved. The alert will send as soon as you are online.', hi: 'इंटरनेट नहीं है और गार्डियन का नंबर नहीं है। ऑनलाइन होते ही अलर्ट जाएगा।' }, { high: true });
      void updateSosEvent(sosId, { smsFallback: 'unavailable' });
    }
  } catch {
    announce({ en: 'The alert is waiting for internet. Keep your phone with you.', hi: 'अलर्ट इंटरनेट का इंतज़ार कर रहा है।' }, { high: true });
    void updateSosEvent(sosId, { smsFallback: 'failed' });
  }
  // Dispatch window: if after 60 s the cloud still has not confirmed and no SMS went out, say so plainly.
  setTimeout(() => {
    const st = useSafety.getState();
    if (currentSosId === sosId && st.phase === 'active' && st.delivery === 'pending') {
      useSafety.setState({ dispatchFailed: true });
      announce({ en: 'I could not deliver the alert yet. I will keep trying. If you can, call someone for help.', hi: 'अलर्ट अभी नहीं पहुँचा। मैं कोशिश करता रहूँगा। हो सके तो किसी को कॉल कीजिए।' }, { critical: true });
    }
  }, 60_000);
}

/** Stick user cancels: during countdown it's a false alarm, after sending it means "I'm safe". */
export function cancelSos() {
  const s = useSafety.getState();
  const name = useSession.getState().person.name;
  if (s.phase === 'countdown') {
    clearInterval(countTimer);
    useSafety.setState({ ...initialSafety });
    announce(P.sosCancelled, { high: true });
    userFx(() => {
      haptics.play('success');
      earcon('cancel');
    });
    logEvent({ kind: 'safety', severity: 'info', title: `SOS cancelled by ${name}`, detail: `Cancelled during the ${getSettings().sosCancelSec}-second countdown` });
    return;
  }
  if (s.phase === 'active') {
    useSafety.setState({ phase: 'resolved', resolvedBy: 'user' });
    if (currentSosId && !isDemo()) {
      void updateSosEvent(currentSosId, { state: 'resolved', resolvedAt: Date.now(), resolvedBy: 'user' });
      stopSosWatch();
      currentSosId = null;
    }
    announce(P.sosResolvedUser, { high: true });
    userFx(() => haptics.play('success'));
    logEvent({ kind: 'safety', severity: 'success', title: `${name} marked themselves safe`, detail: 'SOS closed from the stick user’s phone' });
    resetTimer = setTimeout(() => useSafety.setState({ ...initialSafety }), 4500);
  }
}

/** DEMO MODE guardian actions (real guardians write to Firestore via core/sync/guardianFeed.ts). */
export function guardianAcknowledge() {
  const s = useSafety.getState();
  if (s.phase !== 'active' || s.guardianAck) return;
  const { guardian } = useSession.getState();
  useSafety.setState({ guardianAck: true });
  announce(P.guardianSeen(guardian.heardAs), { high: true });
  logEvent({ kind: 'safety', severity: 'info', title: `${guardian.heardAs} saw the SOS` });
}

export function guardianOnTheWay() {
  const s = useSafety.getState();
  if (s.phase !== 'active' || s.guardianOnWay) return;
  const { guardian, person } = useSession.getState();
  useSafety.setState({ guardianAck: true, guardianOnWay: true });
  announce(P.guardianOnWay(guardian.heardAs), { high: true });
  logEvent({ kind: 'safety', severity: 'info', title: `${guardian.heardAs} is on the way`, detail: `${person.name} was told in his earbuds` });
  toastGuardian(`${person.name} heard that you're on the way`);
}

export function guardianResolve() {
  const s = useSafety.getState();
  if (s.phase !== 'active') return;
  const { guardian } = useSession.getState();
  useSafety.setState({ phase: 'resolved', resolvedBy: 'guardian' });
  announce(P.guardianResolved(guardian.heardAs), { high: true });
  logEvent({ kind: 'safety', severity: 'success', title: `SOS resolved by ${guardian.heardAs}` });
  resetTimer = setTimeout(() => useSafety.setState({ ...initialSafety }), 3500);
}

/** SOS that went out by SMS also reaches the app once the phone is back online. */
export function deliverQueuedSos() {
  const s = useSafety.getState();
  // Demo: SMS-delivered SOS also reaches the app when back online. Real: Firestore confirms via its own snapshot.
  if (isDemo() && s.phase === 'active' && s.delivery === 'sms') useSafety.setState({ delivery: 'cloud' });
}
