import type { ReplyLang } from '../types';
import { useAssistant, pushThread } from '../store/assistant';
import { useSession, getSettings } from '../store/session';
import { useDevice, isLinked } from '../store/device';
import { useNav } from '../store/nav';
import { useSafety } from '../store/safety';
import { logEvent } from '../store/activity';
import { guardianSurfaceActive } from '../surfaces';
import { toastGuardian } from '../store/ui';
import { brain, detectLang, parseCategory } from './brain';
import type { ToolCall, ToolName } from './tools';
import { P, type L } from './phrases';
import { speakReply, resolveLang } from './voiceOut';
import { earcon, loopEarcon } from '../feedback/earcons';
import { haptics } from '../feedback/haptics';
import { stopSpeaking } from '../feedback/speech';
import { recognitionSupported, startRecognition, abortRecognition } from '../voice/recognition';
import { captureFrame } from '../vision/relay';
import { liveSession } from './liveSession';
import { startNavigation, stopNavigation } from '../nav/navigation';
import { nearestLandmark, nearestPlace, routeLengthM, streetAt, HOME, PLACES } from '../sim/geo';
import { startSos, cancelSos } from '../safety/sos';
import { startCall } from '../phone';
import { wait, meters } from '../util';
import { isReal } from '../runtime/mode';
import { realUtterance, realWhereAmI, realDescribeScene } from './realAssistant';

let listenTimer: ReturnType<typeof setTimeout> | undefined;
let stopThinking: (() => void) | null = null;

const set = useAssistant.setState;

function thinking(on: boolean) {
  stopThinking?.();
  stopThinking = on ? loopEarcon('thinking') : null;
}

/** Single press on the stick (or tap on the orb). Pressing again while listening cancels. */
export function startListening() {
  const a = useAssistant.getState();
  if (useSafety.getState().phase === 'countdown') return;
  if (a.phase === 'listening') {
    cancelListening();
    return;
  }
  if (a.phase === 'thinking') return;
  stopSpeaking();
  set({ phase: 'listening', heard: '', reply: '' });
  earcon('listen');
  haptics.play('listen');
  clearTimeout(listenTimer);

  const s = getSettings();
  const lang = resolveLang();
  // Real mode always uses the microphone; demo mode only when enabled.
  if ((isReal() || s.realMic) && recognitionSupported()) {
    if (isReal()) {
      void liveSession.start();
      return;
    }
    const ok = startRecognition({
      lang: lang === 'hi' ? 'hi-IN' : 'en-IN',
      onInterim: (t) => set({ heard: t }),
      onFinal: (t) => void submitUtterance(t),
      onError: (code) => {
        if (useAssistant.getState().phase !== 'listening') return;
        void speakReply((code === 'not-allowed' ? P.micBlocked : P.didntCatch)[lang], lang);
      },
    });
    if (ok) return;
  }
  // Demo mode: waits for a phrase from the demo panel / typed input.
  listenTimer = setTimeout(() => {
    if (useAssistant.getState().phase === 'listening') void speakReply(P.didntCatch[lang], lang);
  }, 15000);
}

export function cancelListening() {
  clearTimeout(listenTimer);
  abortRecognition();
  liveSession.stop();
  set({ phase: 'idle', heard: '' });
  earcon('cancel');
}

/** Demo helper: shows the words appearing as if spoken, then submits. */
export async function simulateSpeech(text: string) {
  if (useAssistant.getState().phase !== 'listening') startListening();
  if (useAssistant.getState().phase !== 'listening') return;
  clearTimeout(listenTimer);
  const words = text.split(' ');
  for (let i = 1; i <= words.length; i++) {
    if (useAssistant.getState().phase !== 'listening') return;
    set({ heard: words.slice(0, i).join(' ') });
    await wait(110);
  }
  await wait(250);
  if (useAssistant.getState().phase === 'listening') void submitUtterance(text);
}

export async function submitUtterance(text: string, source: 'voice' | 'typed' = 'voice') {
  clearTimeout(listenTimer);
  abortRecognition();
  const pref = getSettings().replyLang;
  const lang: ReplyLang = pref === 'auto' ? detectLang(text) : pref;
  if (isReal()) return realUtterance(text, lang, source);
  // ── DEMO: local keyword brain + simulated tools ──
  set({ phase: 'thinking', heard: text, reply: '', lang });
  pushThread('user', text);
  thinking(true);
  try {
    const { contacts } = useSession.getState();
    const res = await brain.respond({
      text,
      lang,
      context: { sosActive: useSafety.getState().phase !== 'idle', navigating: useNav.getState().active, contacts },
    });
    let say: L | null = res.reply ?? null;
    for (const call of res.calls) {
      const out = await runTool(call);
      if (out) say = out;
    }
    thinking(false);
    if (say) {
      pushThread('assistant', say[lang]);
      await speakReply(say[lang], lang);
    } else set({ phase: 'idle' });
  } catch {
    thinking(false);
    await speakReply(P.brainError[lang], lang);
  }
}

/** Double / triple press: run a tool straight away, no speech-to-text round trip. */
export async function runDirect(name: Extract<ToolName, 'where_am_i' | 'describe_scene'>, label: string) {
  if (useAssistant.getState().phase === 'thinking') return;
  stopSpeaking();
  abortRecognition();
  const lang = resolveLang();
  set({ phase: 'thinking', heard: label, reply: '' });
  earcon('listen');
  if (isReal()) {
    pushThread('user', label);
    if (name === 'where_am_i') return realWhereAmI(lang);
    return realDescribeScene(lang);
  }
  thinking(true);
  const say = await runTool({ name } as ToolCall);
  thinking(false);
  if (say) await speakReply(say[lang], lang);
  else set({ phase: 'idle' });
}

const online = () => useDevice.getState().internet;
const stickUp = () => isLinked(useDevice.getState().link);

/** DEMO MODE executor (simulated world). Real mode uses ./executor.ts. */
async function runTool(call: ToolCall): Promise<L | null> {
  const person = useSession.getState().person.name;
  switch (call.name) {
    case 'describe_scene':
    case 'read_text':
    case 'identify_currency': {
      if (!online()) return P.offline;
      if (!stickUp()) return P.noStick;
      const hint = call.name === 'read_text' ? 2 : call.name === 'identify_currency' ? 3 : undefined;
      try {
        const frame = await captureFrame('assistant', hint);
        await wait(450); // vision model latency
        set({ card: { kind: 'scene', title: call.name === 'describe_scene' ? 'Described the scene' : call.name === 'read_text' ? 'Read the sign' : 'Checked the note' } });
        logEvent({ kind: 'vision', severity: 'info', title: 'Assistant described the scene', detail: `${person} asked what was ahead (demo)` });
        return call.name === 'read_text' ? P.readText : call.name === 'identify_currency' ? P.currency : P.scenes[frame.scene];
      } catch {
        return P.noStick;
      }
    }
    case 'where_am_i': {
      const pos = useNav.getState().userPos;
      const lm = nearestLandmark(pos);
      const homeM = routeLengthM(pos, HOME.pos);
      set({ card: { kind: 'location', title: streetAt(pos), detail: `Near ${lm.place.name}` } });
      return P.whereAmI(streetAt(pos), lm.place, lm.meters, homeM);
    }
    case 'navigate_to': {
      if (!online()) return P.offlineNav;
      const pos = useNav.getState().userPos;
      const q = call.args.query ?? '';
      const category = call.args.category ?? parseCategory(q);
      const byName = PLACES.find((p) => q && q.toLowerCase().includes(p.name.toLowerCase()));
      const place = byName ?? (category ? nearestPlace(category, pos) : null);
      if (!place) return P.noPlace;
      const r = startNavigation(place);
      set({ card: { kind: 'navigation', title: place.name, detail: `${meters(r.lengthM)}, about ${r.minutes} min` } });
      return P.navStart(place, r.lengthM, r.minutes, r.first);
    }
    case 'stop_navigation':
      stopNavigation();
      set({ card: null });
      return P.navStopped;
    case 'call_contact': {
      const c = useSession.getState().contacts.find((x) => x.id === call.args.contact);
      if (!c) return P.noContact;
      startCall(c.name);
      set({ card: { kind: 'call', title: `Calling ${c.name}` } });
      return P.calling(c.name);
    }
    case 'send_message': {
      const { contacts, guardian } = useSession.getState();
      const c = contacts.find((x) => x.id === call.args.contact);
      if (!c) return P.noContact;
      set({ card: { kind: 'message', title: `Message to ${c.name}`, detail: call.args.text } });
      logEvent({ kind: 'message', severity: 'info', title: `${person} sent a message to ${c.name}`, detail: call.args.text });
      if (c.name === guardian.heardAs && guardianSurfaceActive()) toastGuardian(`${person}: “${call.args.text}”`);
      return P.messageSent(c.name, call.args.text);
    }
    case 'get_status': {
      const d = useDevice.getState();
      const pct = d.battery.percent ?? 0;
      set({ card: { kind: 'status', title: d.battery.percent == null ? 'Battery unknown' : `Stick about ${pct}%` } });
      return P.status(pct, isLinked(d.link));
    }
    case 'get_time':
      return P.time(new Date());
    case 'trigger_sos':
      if (getSettings().sosTriggers.voice) startSos('voice');
      return null;
    case 'cancel_sos':
      cancelSos();
      return null;
    case 'repeat_last': {
      const last = useAssistant.getState().lastSpoken;
      return last ? { en: last.text, hi: last.text } : P.nothingYet;
    }
  }
}
