import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import { create } from 'zustand';
import { earcon } from '../feedback/earcons';
import { haptics } from '../feedback/haptics';
import { startConnectingTune } from '../audio/connectingTune';
import { useSafety } from '../store/safety';
import { call } from '../backend/api';
import { TOOLS } from '../../../shared/tools';
import { toGeminiParameters } from '../../../shared/validate';
import { useAssistant, pushThread } from '../store/assistant';
import { useSession } from '../store/session';
import { useDevice, isLinked } from '../store/device';
import { useLocation } from '../location/locationService';
import { useNavView } from '../navigation/navView';
import { MicStream } from '../voice/micStream';
import { executeAction } from './executor';
import { confirmPendingOffer, clearOffer, isAffirmative, isNegative, pendingOffer } from './navIntent';
import * as audioManager from '../audio/audioManager';
import { log } from '../log';

/**
 * Gemini Live voice session (the stick's AI button in real mode).
 *
 *   button → getLiveToken (Firebase callable: signed-in user + App Check, one-use ephemeral token,
 *   model locked server-side) → ai.live.connect(v1alpha) → mic 16 kHz PCM → model voice 24 kHz PCM →
 *   audioManager (the one audio owner) → speaker / earbuds.
 *
 * Tools run through the same validated executor as the text assistant. Side-effect tools marked
 * `confirm` need the user's spoken "yes" first; navigation offers are confirmed deterministically
 * by the app (core/ai/navIntent.ts), not by trusting the model.
 */
/** Whole connect budget (token + socket + open). The connecting tune never rings longer. */
export const CONNECT_TIMEOUT_MS = 20_000;
const TOKEN_TIMEOUT_MS = 15_000;
const TIMEOUT_MSG = 'The assistant took too long to connect.';
/** Close the mic after this long with neither user speech nor model output. */
const IDLE_CLOSE_MS = 45_000;

/** UI hint: true while the Live assistant is connecting (show "Connecting…", not "Thinking…"). */
export const useLiveStatus = create<{ connecting: boolean }>(() => ({ connecting: false }));

function phoneOffline() {
  return useDevice.getState().internet === false || (typeof navigator !== 'undefined' && navigator.onLine === false);
}

/** Why the assistant could not start: a short on-screen label and the sentence the user hears. */
export function startFailure(msg: string, code = '', name = ''): { label: string; spoken: string } {
  const all = `${code} ${msg}`;
  if (/NotAllowedError|SecurityError/.test(name) || /microphone|NotAllowedError/i.test(msg))
    return { label: 'Microphone permission needed', spoken: 'Microphone permission is needed for the assistant. Please allow the microphone for AI SmartStick in phone settings.' };
  if (/NotFoundError|NotReadableError/.test(name)) return { label: 'Microphone not available', spoken: 'The microphone is not available, so the assistant cannot listen.' };
  if (/unauthenticated|app.?check|sign in/i.test(all)) return { label: 'Please sign in again', spoken: 'The assistant needs you to sign in again. Please sign in and try again.' };
  if (/resource-exhausted|too many/i.test(all)) return { label: 'Assistant busy, try again soon', spoken: 'The assistant is busy right now. Please wait a minute and try again.' };
  if (phoneOffline()) return { label: 'No internet', spoken: 'The phone has no internet, so the assistant cannot connect. The stick still warns you about obstacles.' };
  if (msg === TIMEOUT_MSG || /deadline|timeout|timed out/i.test(all)) return { label: 'Connection timed out', spoken: 'The assistant took too long to connect. Please check the internet and press again.' };
  return { label: 'Could not connect', spoken: "I couldn't reach the assistant. Please press the button to try again." };
}

export const startFailureMessage = (msg: string, code = '', name = '') => startFailure(msg, code, name).spoken;

function closeQuietly(s: Session) {
  try {
    s.close();
  } catch {
    /* already closed */
  }
}

const tools = [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiParameters(t.params) as never })) }];

function systemPrompt() {
  const s = useSession.getState();
  const d = useDevice.getState();
  const nav = useNavView.getState();
  return `You are the AI SmartStick voice assistant for a blind or low-vision person, speaking through their phone while they walk. Be brief, warm and concrete: one or two short sentences. Reply in the language the user speaks (English or Hindi).

NAVIGATION
- When the user wants to go somewhere: call find_nearest_place (category) or search_place (name). The result has an "offered" place.
- Say the offered place's name and distance in metres, then ask "Should I take you there?". Never invent places or distances.
- When the user says yes, call start_navigation with the offered placeId. Never search again for the same request. If the result says alreadyNavigating, just confirm that directions have started and give the first instruction.
- When the user names one specific place or address to go to ("set destination to City Hospital", "take me to MG Road"), call set_destination with query set to that name. It sets the destination and starts directions.
- GPS is NOT needed to search or to set a destination. If a result says directions "waiting_for_gps", say the destination is set and directions will start automatically as soon as GPS finds their position. Never tell the user that location or maps are unavailable when they ask to go somewhere.

SAFETY
- Never say it is safe to cross a road, walk ahead, or that a path is clear. Describe what was observed and how certain it is; remind the user to use their cane and hearing.
- trigger_sos only when the user clearly asks for help or says it is an emergency. cancel_sos only when they say they are okay.
- Tools marked as needing confirmation return needsConfirmation: ask the user, and call again only after they say yes.
- A text message counts as sent only if the tool result says "sent".
- If a tool fails, say briefly what failed and what still works (the stick keeps vibrating for obstacles offline).

CONTEXT: user ${s.person.name || 'unknown'}; stick ${isLinked(d.link) ? 'connected' : 'not connected'}; GPS ${useLocation.getState().fix ? 'available' : 'not available yet (destinations can still be set)'}; navigating ${nav.active ? `to ${nav.destination?.name}` : 'no'}; local time ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.`;
}

type StopReason = 'user' | 'idle' | 'error' | 'remote';

export class LiveSession {
  private session: Session | null = null;
  private mic: MicStream | null = null;
  private active = false;
  private connecting = false;
  private generation = 0;
  private outText = '';
  private inText = '';
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopTone: () => void = () => {};
  /** Confirm-gated tool waiting for the user's "yes". */
  private pendingConfirm: { name: string; args: unknown } | null = null;
  private confirmedByUser = false;
  /** The user's last complete utterance (for confirmations arriving with the model's tool call). */
  private lastUserText = '';
  private wordsTimer: ReturnType<typeof setTimeout> | undefined;

  get isActive() {
    return this.active;
  }

  /** One camera photo (JPEG base64) into the running Live conversation; Live sees it natively. */
  sendImage(b64: string): boolean {
    if (!this.active || !this.session || this.connecting) return false;
    this.session.sendRealtimeInput({ video: { data: b64, mimeType: 'image/jpeg' } });
    return true;
  }

  /** True while the Live socket is being set up (the connecting tune is playing). */
  get isConnecting() {
    return this.active && this.connecting;
  }

  async start(): Promise<boolean> {
    if (this.active) return true;
    this.active = true;
    this.connecting = true;
    const gen = ++this.generation;
    const stale = () => gen !== this.generation;
    useAssistant.setState({ phase: 'thinking', unavailable: null, heard: '', reply: '' });
    useLiveStatus.setState({ connecting: true });
    // Started inside the tap / button handler, so the audio context is unlocked right here.
    this.stopTone();
    this.stopTone = startConnectingTune();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // One budget for token + socket + open: the tune never rings longer than this.
      const timeout = new Promise<never>((_, rej) => {
        deadline = setTimeout(() => rej(new Error(TIMEOUT_MSG)), CONNECT_TIMEOUT_MS);
      });
      const cfg = await Promise.race([call<Record<string, never>, { token: string; liveModel: string }>('getLiveToken', {}, TOKEN_TIMEOUT_MS), timeout]);
      if (stale()) return false;
      if (!cfg?.token || !cfg.liveModel) throw new Error('The server returned no Live token.');
      const ai = new GoogleGenAI({ apiKey: cfg.token, httpOptions: { apiVersion: 'v1alpha' } });

      let opened: () => void = () => {};
      let failed: (e: Error) => void = () => {};
      const openPromise = new Promise<void>((res, rej) => {
        opened = res;
        failed = rej;
      });
      // A socket error can arrive before anyone awaits openPromise: never an unhandled rejection.
      openPromise.catch(() => undefined);
      const connect = ai.live.connect({
        model: cfg.liveModel,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: systemPrompt() }] },
          tools,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => opened(),
          onmessage: (msg: LiveServerMessage) => {
            if (!stale()) void this.onMessage(msg);
          },
          onerror: (e: ErrorEvent) => {
            log.error('live: socket error', { error: e?.message });
            failed(new Error(e?.message || 'Live connection error'));
            if (!stale() && this.session && !this.connecting) this.stop('error', 'The assistant connection was lost. Press the button to talk again.', 'Connection lost');
          },
          onclose: (e: CloseEvent) => {
            failed(new Error(e?.reason || `Live connection closed (${e?.code ?? 'no code'})`));
            if (stale() || !this.active || this.connecting) return;
            // The server closes with a reason when the model, token or config is rejected.
            log.warn('live: closed by server', { code: e?.code, reason: e?.reason });
            this.stop('remote', e?.code && e.code !== 1000 ? `The assistant disconnected${e.reason ? `: ${e.reason}` : ''}.` : undefined, 'Assistant disconnected');
          },
        },
      });
      // A late socket (after a timeout or cancel) must be closed, never left open.
      connect.then(
        (s) => {
          if (stale()) closeQuietly(s);
        },
        () => undefined,
      );
      const session = await Promise.race([connect, timeout]);
      if (stale()) {
        closeQuietly(session);
        return false;
      }
      this.session = session;
      await Promise.race([openPromise, timeout]);
      clearTimeout(deadline);
      if (stale()) return false;
      // Connected: the tune stops now, then the "listening" earcon (never on top of each other).
      this.connecting = false;
      this.stopTone();
      this.stopTone = () => {};
      useLiveStatus.setState({ connecting: false });

      audioManager.setLiveSessionOpen(true);
      earcon('listen');
      haptics.play('listen');
      const mic = new MicStream();
      this.mic = mic;
      mic.onData = (data) => {
        if (this.active && this.session) this.session.sendRealtimeInput({ audio: { data, mimeType: 'audio/pcm;rate=16000' } });
      };
      await mic.start();
      if (stale()) {
        // Stopped while the permission prompt / getUserMedia was pending: never leave the mic open.
        mic.stop();
        return false;
      }
      log.info('live: session open', { model: cfg.liveModel, micRate: mic.sampleRate });
      useAssistant.setState({ phase: 'listening' });
      this.bumpIdle();
      return true;
    } catch (e) {
      if (stale()) return false;
      const msg = (e as Error).message || 'Could not connect to the assistant.';
      const code = String((e as { code?: string }).code ?? '');
      const name = String((e as Error).name ?? '');
      log.error('live: start failed', { error: msg, code, name });
      const why = startFailure(msg, code, name);
      this.stop('error', why.spoken, why.label);
      return false;
    } finally {
      clearTimeout(deadline);
    }
  }

  /** SOS took over: a connection still being set up is abandoned (an open one keeps running). */
  onSosStarted() {
    if (this.active && this.connecting) {
      log.info('live: SOS started while connecting; connection abandoned');
      this.stop('user');
    }
  }

  private bumpIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.active && !audioManager.livePcmPlaying()) this.stop('idle');
      else if (this.active) this.bumpIdle();
    }, IDLE_CLOSE_MS);
  }

  private async onMessage(msg: LiveServerMessage) {
    const sc = msg.serverContent;
    if (sc?.interrupted) audioManager.interruptPcm();

    // What the user said (transcribed by the Live API).
    if (sc?.inputTranscription?.text) {
      this.bumpIdle();
      this.inText += sc.inputTranscription.text;
      useAssistant.setState({ heard: this.inText.trim() });
      // Transcription arrives in pieces ("Okay" … ", what about a hospital?"): judge the utterance
      // only once it has settled, never a first fragment.
      clearTimeout(this.wordsTimer);
      const snapshot = this.inText;
      this.wordsTimer = setTimeout(() => {
        if (this.active && this.inText === snapshot) void this.onUserWords(snapshot);
      }, 900);
    }
    if (sc?.outputTranscription?.text) this.outText += sc.outputTranscription.text;

    for (const part of sc?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.bumpIdle();
        if (useAssistant.getState().phase !== 'speaking') useAssistant.setState({ phase: 'speaking' });
        audioManager.playPcmChunk(part.inlineData.data, 24000);
      }
    }

    if (sc?.turnComplete || sc?.generationComplete) {
      if (this.inText.trim()) {
        clearTimeout(this.wordsTimer);
        this.lastUserText = this.inText.trim();
        pushThread('user', this.lastUserText);
        void this.onUserWords(this.lastUserText);
      }
      if (this.outText.trim()) {
        pushThread('assistant', this.outText.trim());
        useAssistant.setState({ reply: this.outText.trim(), lastSpoken: { text: this.outText.trim(), lang: useAssistant.getState().lang } });
      }
      this.inText = '';
      this.outText = '';
      // Still in the conversation: the mic stays open for a follow-up ("yes").
      if (this.active) useAssistant.setState({ phase: 'listening' });
    }

    if (msg.toolCallCancellation?.ids?.length) log.info('live: tool calls cancelled', { ids: msg.toolCallCancellation.ids });
    const calls = msg.toolCall?.functionCalls;
    if (calls?.length) await this.runTools(calls);
  }

  /** Deterministic confirmations from the user's own words. */
  private async onUserWords(text: string) {
    if (isNegative(text)) {
      if (pendingOffer()) clearOffer();
      this.pendingConfirm = null;
      return;
    }
    if (!isAffirmative(text)) return;
    if (this.pendingConfirm) this.confirmedByUser = true;
    if (pendingOffer() && !confirming) {
      confirming = true;
      try {
        const r = await confirmPendingOffer();
        if (r?.started) {
          earcon('success');
          log.info('live: navigation confirmed by voice', { placeId: r.place.placeId });
        }
      } catch (e) {
        log.error('live: confirmed navigation failed to start', { error: (e as Error).message });
      } finally {
        confirming = false;
      }
    }
  }

  private async runTools(calls: NonNullable<LiveServerMessage['toolCall']>['functionCalls'] & object) {
    const responses: { id?: string; name?: string; response: Record<string, unknown> }[] = [];
    useAssistant.setState({ phase: 'thinking' });
    for (const c of calls) {
      const name = c.name ?? '';
      const spec = TOOLS.find((t) => t.name === name);
      if (!spec) {
        responses.push({ id: c.id, name, response: { error: `Unknown tool ${name}` } });
        continue;
      }
      if (spec.confirm) {
        const same = this.pendingConfirm?.name === name;
        // The "yes" may still be settling when the model calls the tool again.
        const saidYes = this.confirmedByUser || isAffirmative(this.inText) || isAffirmative(this.lastUserText);
        if (!same || !saidYes) {
          this.pendingConfirm = { name, args: c.args };
          this.confirmedByUser = false;
          responses.push({ id: c.id, name, response: { needsConfirmation: true, instruction: 'Ask the user to confirm in one short sentence. Call this tool again only after they say yes.' } });
          continue;
        }
        this.pendingConfirm = null;
        this.confirmedByUser = false;
      }
      try {
        const out = await executeAction({ id: c.id ?? `live_${Date.now()}`, name: name as never, type: spec.type, arguments: (c.args ?? {}) as never });
        responses.push({ id: c.id, name, response: out.ok ? { result: out.data } : { error: out.error } });
      } catch (e) {
        responses.push({ id: c.id, name, response: { error: (e as Error).message } });
      }
    }
    if (this.active && this.session) this.session.sendToolResponse({ functionResponses: responses });
    if (this.active && useAssistant.getState().phase === 'thinking') useAssistant.setState({ phase: 'listening' });
  }

  /** Ends the session (or the connection attempt). Always silences the connecting tune. */
  stop(reason: StopReason = 'user', spoken?: string, label?: string) {
    const wasActive = this.active;
    this.generation++;
    this.active = false;
    this.connecting = false;
    if (useLiveStatus.getState().connecting) useLiveStatus.setState({ connecting: false });
    clearTimeout(this.idleTimer);
    clearTimeout(this.wordsTimer);
    this.lastUserText = '';
    this.stopTone();
    this.stopTone = () => {};
    this.mic?.stop();
    this.mic = null;
    const s = this.session;
    this.session = null;
    try {
      s?.close();
    } catch {
      /* already closed */
    }
    audioManager.setLiveSessionOpen(false);
    this.inText = '';
    this.outText = '';
    this.pendingConfirm = null;
    this.confirmedByUser = false;
    if (reason === 'error' || (reason === 'remote' && spoken)) {
      useAssistant.setState({ phase: 'error', unavailable: label ?? spoken ?? 'The assistant is unavailable.' });
      if (spoken) void audioManager.say(spoken, { lang: useAssistant.getState().lang, priority: 'user' });
      setTimeout(() => useAssistant.getState().phase === 'error' && useAssistant.setState({ phase: 'idle' }), 4000);
    } else {
      if (wasActive && reason === 'idle') earcon('cancel');
      useAssistant.setState({ phase: 'idle' });
    }
  }
}

let confirming = false;
export const liveSession = new LiveSession();

// SOS has priority over everything: abandon a Live connection that is still being set up.
useSafety.subscribe((s, prev) => {
  if (prev.phase === 'idle' && s.phase !== 'idle') liveSession.onSosStarted();
});
