import type { Action, AssistantContext, AssistantTurnRequest, AssistantTurnResponse, ToolResult } from '../../../shared/assistantContract';
import type { ReplyLang } from '../types';
import { call, BackendError } from '../backend/api';
import { useAssistant, pushThread } from '../store/assistant';
import { useDevice, isLinked } from '../store/device';
import { useSession } from '../store/session';
import { useSafety } from '../store/safety';
import { useLocation } from '../location/locationService';
import { useNavView } from '../navigation/navView';
import { executeAction, runVision } from './executor';
import { speakReply } from './voiceOut';
import { onStickButton } from '../device/bridge';
import { startRecognition, abortRecognition } from '../voice/recognition';
import { loopEarcon } from '../feedback/earcons';
import { reverseLookup } from '../maps/mapsService';
import { freshnessLabel } from '../location/locationService';
import { firebaseConfigured } from '../runtime/env';
import { TOOL_BY_NAME } from '../../../shared/tools';

/**
 * REAL assistant turn loop (Gemini via Cloud Function `assistantTurn`):
 *   speech/text → backend → Gemini → actions → THIS APP validates & executes → results → backend
 *   → Gemini → final reply → TTS.   At most 4 tool rounds per user turn.
 * The backend keeps the conversation (and Gemini's thought signatures) in Firestore.
 */
const MAX_ROUNDS = 4;
const NEW_CONVERSATION_AFTER_MS = 10 * 60_000;
let lastTurnAt = 0;
let stopThinking: (() => void) | null = null;

const set = useAssistant.setState;

function thinking(on: boolean) {
  stopThinking?.();
  stopThinking = on ? loopEarcon('thinking') : null;
}

function context(): AssistantContext {
  const d = useDevice.getState();
  const g = useSession.getState().guardian;
  return {
    deviceConnected: isLinked(d.link),
    internet: d.internet === true,
    navigating: useNavView.getState().active,
    sosPhase: useSafety.getState().phase,
    locationAvailable: !!useLocation.getState().fix,
    guardianName: g.heardAs || g.name || null,
    localTime: new Date().toLocaleString('en-IN'),
  };
}

function unavailableReason(): string | null {
  if (!firebaseConfigured()) return 'The assistant backend is not configured.';
  if (useDevice.getState().internet === false) return 'The phone is offline.';
  return null;
}

async function turn(input: AssistantTurnRequest['input'], lang: ReplyLang) {
  const cid = Date.now() - lastTurnAt > NEW_CONVERSATION_AFTER_MS ? null : useAssistant.getState().conversationId;
  const res = await call<AssistantTurnRequest, AssistantTurnResponse>('assistantTurn', { conversationId: cid ?? undefined, lang, input, context: context() }, 45000);
  set({ conversationId: res.conversationId });
  lastTurnAt = Date.now();
  return res;
}

/** Ask the user to confirm a sensitive action: one stick press or "yes" = confirm. */
async function confirm(prompt: string, lang: ReplyLang): Promise<boolean> {
  set({ awaitingConfirmation: prompt });
  await speakReply(prompt, lang, 'high');
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      off();
      abortRecognition();
      clearTimeout(t);
      set({ awaitingConfirmation: null, phase: 'thinking' });
      resolve(v);
    };
    const off = onStickButton((p) => {
      if (p === 'single') finish(true);
      else if (p === 'double') finish(false);
      else return false; // the 3 s SOS hold must always reach the SOS handler
      return true;
    });
    set({ phase: 'listening', heard: '' });
    startRecognition({
      lang: lang === 'hi' ? 'hi-IN' : 'en-IN',
      onInterim: (t) => set({ heard: t }),
      onFinal: (t) => finish(/\b(yes|yeah|haan|ha|han|ok|okay|sure|send|confirm|कर|हाँ|हां)\b/i.test(t)),
      onError: () => undefined,
    });
    const t = setTimeout(() => finish(false), 10000);
  });
}

function describe(actions: Action[]) {
  return actions
    .map((a) => (a.type === 'communication.sendSmsToGuardian' ? `send this text to your guardian: "${String(a.arguments.text ?? '')}"` : TOOL_BY_NAME.get(a.name)?.description ?? a.name))
    .join(', ');
}

export async function realUtterance(text: string, lang: ReplyLang, source: 'voice' | 'typed' | 'button') {
  const why = unavailableReason();
  set({ phase: 'thinking', heard: text, reply: '', lang, unavailable: why });
  pushThread('user', text);
  if (why) {
    const msg = lang === 'hi' ? 'अभी असिस्टेंट उपलब्ध नहीं है। स्टिक की सुरक्षा चालू है।' : `The assistant is unavailable: ${why} Stick safety still works.`;
    pushThread('system', msg);
    await speakReply(msg, lang);
    return;
  }
  thinking(true);
  try {
    let res = await turn({ kind: 'text', text, source }, lang);
    for (let round = 0; round < MAX_ROUNDS && res.actions.length; round++) {
      let results: ToolResult[];
      if (res.requiresConfirmation) {
        thinking(false);
        const prompt = res.reply?.text ?? (lang === 'hi' ? `क्या मैं ${describe(res.actions)}? पुष्टि के लिए बटन एक बार दबाइए।` : `Should I ${describe(res.actions)}? Press the stick button once or say yes.`);
        const yes = await confirm(prompt, lang);
        thinking(true);
        results = yes ? await Promise.all(res.actions.map(executeAction)) : res.actions.map((a) => ({ id: a.id, name: a.name, ok: false, error: 'The user declined.' }));
      } else results = await Promise.all(res.actions.map(executeAction));
      res = await turn({ kind: 'toolResults', results }, lang);
    }
    thinking(false);
    if (res.reply?.text) {
      pushThread('assistant', res.reply.text);
      await speakReply(res.reply.text, res.reply.language ?? lang, res.priority === 'critical' ? 'critical' : res.priority === 'high' ? 'high' : 'normal');
    } else set({ phase: 'idle' });
  } catch (e) {
    thinking(false);
    const err = e instanceof BackendError ? e : null;
    const msg =
      lang === 'hi'
        ? 'माफ़ कीजिए, असिस्टेंट से जवाब नहीं मिला। फिर से कोशिश कीजिए।'
        : err?.code === 'functions/unauthenticated'
          ? 'Please sign in again to use the assistant.'
          : 'Sorry, I could not reach the assistant. Please try again.';
    set({ unavailable: err?.message ?? 'error', phase: 'error' });
    pushThread('system', msg);
    await speakReply(msg, lang);
  }
}

/** Double press: "Where am I?" — straight from GPS + Maps, no model round trip. */
export async function realWhereAmI(lang: ReplyLang) {
  const l = useLocation.getState();
  const d = useDevice.getState();
  if (!l.fix) return speakReply(lang === 'hi' ? 'अभी GPS लोकेशन नहीं मिली है।' : l.permission === 'denied' ? 'Location permission is off, so I cannot tell where you are.' : 'I do not have a GPS position yet. Please wait a moment.', lang);
  const acc = Math.round(l.fix.accuracyM);
  const fresh = freshnessLabel(l.fix.ts);
  if (d.internet !== true) return speakReply(lang === 'hi' ? `इंटरनेट नहीं है, पता नहीं खोज सकता। GPS की सटीकता करीब ${acc} मीटर।` : `I can't look up the address offline. Your GPS position is accurate to about ${acc} meters, ${fresh.toLowerCase()}.`, lang);
  try {
    const r = await reverseLookup(l.fix.lat, l.fix.lng);
    const parts = [r.address ? `You are near ${r.address}` : 'I found your position but no street address'];
    if (r.landmark) parts.push(`about ${Math.round(r.landmark.distanceM / 5) * 5 || 5} meters from ${r.landmark.name}`);
    const text = `${parts.join(', ')}. GPS accuracy is about ${acc} meters.`;
    pushThread('assistant', text);
    return speakReply(text, 'en');
  } catch {
    return speakReply('I could not look up your address right now.', lang);
  }
}

/** Triple press: "What's in front of me?" — capture + vision, spoken with its uncertainty. */
export async function realDescribeScene(lang: ReplyLang) {
  if (!isLinked(useDevice.getState().link)) return speakReply(lang === 'hi' ? 'स्टिक जुड़ी नहीं है, कैमरा उपलब्ध नहीं।' : 'The stick is not connected, so the camera is unavailable.', lang);
  if (useDevice.getState().internet !== true) return speakReply(lang === 'hi' ? 'इंटरनेट नहीं है, तस्वीर समझ नहीं सकता। रुकावट सेंसर चालू है।' : 'No internet, so I cannot interpret the camera. The obstacle sensor is still working.', lang);
  thinking(true);
  set({ phase: 'vision' });
  try {
    const r = await runVision('describe_scene');
    thinking(false);
    pushThread('assistant', r.spoken);
    await speakReply(r.spoken, lang, 'vision');
  } catch (e) {
    thinking(false);
    set({ phase: 'error', unavailable: (e as Error).message === 'stick-offline' ? 'stick camera not responding' : 'vision unavailable' });
    await speakReply((e as Error).message === 'stick-offline' ? 'The stick camera did not respond.' : 'I could not analyse the photo right now.', lang);
  }
}

// Watchdog: THINKING/VISION can never be shown forever. If a turn exceeds 60 s, fail it honestly.
let phaseSince = 0;
let lastPhase = useAssistant.getState().phase;
useAssistant.subscribe((a) => {
  if (a.phase !== lastPhase) {
    lastPhase = a.phase;
    phaseSince = Date.now();
  }
});
setInterval(() => {
  const a = useAssistant.getState();
  if ((a.phase === 'thinking' || a.phase === 'vision') && Date.now() - phaseSince > 60_000) {
    thinking(false);
    useAssistant.setState({ phase: 'error', unavailable: 'timed out' });
    void speakReply('Sorry, that took too long. Please try again.', a.lang);
  }
}, 5000);
