import { create } from 'zustand';
import type { ReplyLang } from '../types';
import { getSettings } from '../store/session';
import { ttsEngine } from './tts';

/**
 * UnifiedAudioOrchestrator — the ONE speech path (one TTS engine, one queue, one mono output).
 * Every speaking feature (assistant replies, vision results, navigation, safety, SOS, camera
 * notices, guardian messages, system) enqueues here; nothing calls a TTS engine directly.
 * It controls only AI SmartStick audio, never other apps' media.
 *
 *   P0 critical   emergency / SOS / obstacle danger        interrupts everything
 *   P1 high       critical navigation, disconnects, battery, guardian messages
 *   P2 user       reply to the user's active request       interrupts P3–P6
 *   P3 vision     AI vision results
 *   P4 nav        normal turn-by-turn
 *   P5 normal     informational
 *   P6 background hints (dropped if anything else is queued)
 *
 * Interruption policy: a new item interrupts the current one only if it is ≥ P2 and strictly
 * higher. An interrupted P2/P3/P5 item is replayed once afterwards if still fresh (< 20 s);
 * interrupted navigation (P4) is discarded (stale directions are worse than none).
 */
export type Priority = 'critical' | 'high' | 'user' | 'vision' | 'nav' | 'normal' | 'background';
const RANK: Record<Priority, number> = { critical: 6, high: 5, user: 4, vision: 3, nav: 2, normal: 1, background: 0 };
export const PRIORITY_LEVEL: Record<Priority, string> = { critical: 'P0', high: 'P1', user: 'P2', vision: 'P3', nav: 'P4', normal: 'P5', background: 'P6' };
const RESUME_WINDOW_MS = 20_000;
const interruptListeners = new Set<(text: string) => void>();
/** The assistant listens here to show 'interrupted' on the orb. */
export const onInterrupted = (cb: (text: string) => void) => {
  interruptListeners.add(cb);
  return () => {
    interruptListeners.delete(cb);
  };
};

interface Item {
  id: number;
  queuedAt: number;
  text: string;
  lang: ReplyLang;
  priority: Priority;
  dedupeKey?: string;
  resolve: (r: SayResult) => void;
  resumable: boolean;
}

export type SayResult = 'spoken' | 'dropped' | 'interrupted' | 'muted';

interface AudioState {
  speaking: boolean;
  current: { text: string; priority: Priority } | null;
  lastSpoken: { text: string; lang: ReplyLang } | null;
  queueLength: number;
}

export const useAudio = create<AudioState>(() => ({ speaking: false, current: null, lastSpoken: null, queueLength: 0 }));

let queue: Item[] = [];
let current: Item | null = null;
let seq = 0;
let interrupting = false;

const volume = () => Math.max(0, Math.min(1, (getSettings().assistantVolume ?? 100) / 100));

function publish() {
  useAudio.setState({ speaking: !!current, current: current ? { text: current.text, priority: current.priority } : null, queueLength: queue.length });
}

function enqueue(item: Item) {
  if (item.dedupeKey) {
    queue = queue.filter((q) => {
      if (q.dedupeKey === item.dedupeKey) {
        q.resolve('dropped');
        return false;
      }
      return true;
    });
  }
  if (item.priority === 'background' && (current || queue.length)) {
    item.resolve('dropped');
    return;
  }
  if (RANK[item.priority] <= RANK.user && queue.filter((q) => q.priority === item.priority).length >= 4) {
    const drop = queue.find((q) => q.priority === item.priority);
    if (drop) {
      queue = queue.filter((q) => q !== drop);
      drop.resolve('dropped');
    }
  }
  // Stable priority order.
  const idx = queue.findIndex((q) => RANK[q.priority] < RANK[item.priority]);
  if (idx === -1) queue.push(item);
  else queue.splice(idx, 0, item);
}

async function pump() {
  if (current || interrupting) return;
  const next = queue.shift();
  if (!next) {
    publish();
    return;
  }
  current = next;
  publish();
  const s = getSettings();
  let result: SayResult = 'spoken';
  try {
    if (!s.voiceOut && next.priority !== 'critical') result = 'muted';
    else await ttsEngine().speak(next.text, { lang: next.lang, rate: s.voiceRate, volume: volume() });
  } catch {
    result = 'spoken';
  }
  if (current === next) {
    current = null;
    if (result === 'spoken') useAudio.setState({ lastSpoken: { text: next.text, lang: next.lang } });
    next.resolve(result);
  }
  publish();
  void pump();
}

export function say(text: string, o: { lang: ReplyLang; priority?: Priority; dedupeKey?: string } ): Promise<SayResult> {
  const priority = o.priority ?? 'normal';
  return new Promise<SayResult>((resolve) => {
    const item: Item = { id: ++seq, queuedAt: Date.now(), text, lang: o.lang, priority, dedupeKey: o.dedupeKey, resolve, resumable: priority === 'user' || priority === 'vision' || priority === 'normal' };
    if (current && RANK[priority] > RANK[current.priority] && RANK[priority] >= RANK.user) {
      const cut = current;
      current = null;
      interrupting = true;
      interruptListeners.forEach((l) => l(cut.text));
      void ttsEngine()
        .stop()
        .finally(() => {
          interrupting = false;
          if (cut.resumable && Date.now() - cut.queuedAt < RESUME_WINDOW_MS) enqueue({ ...cut, resumable: false });
          else cut.resolve('interrupted');
          enqueue(item);
          publish();
          void pump();
        });
      return;
    }
    enqueue(item);
    publish();
    void pump();
  });
}

/** Stop everything (e.g. user starts talking, or "stop"). */
export async function stopAll() {
  const q = queue;
  queue = [];
  q.forEach((i) => i.resolve('interrupted'));
  const cut = current;
  current = null;
  if (cut) cut.resolve('interrupted');
  publish();
  try {
    await ttsEngine().stop();
  } catch {
    /* ignore */
  }
}

export const audioVolume = volume;


// --- NATIVE PCM SUPPORT FOR GEMINI LIVE ---
let audioCtx: AudioContext | null = null;
let pcmStartTime = 0;
let pcmPlaying = false;


function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

export function playPcmChunk(base64: string, sampleRate = 24000) {
  if (!getSettings().voiceOut) return;
  const ctx = getAudioCtx();
  
  // Convert base64 to Float32Array
  const binaryString = atob(base64);
  const len = binaryString.length;
  // PCM 16-bit
  const floats = new Float32Array(len / 2);
  for (let i = 0; i < len / 2; i++) {
    const lsb = binaryString.charCodeAt(i * 2);
    const msb = binaryString.charCodeAt(i * 2 + 1);
    let int16 = (msb << 8) | lsb;
    if (int16 >= 0x8000) int16 -= 0x10000;
    floats[i] = int16 / 0x8000;
  }
  
  const buffer = ctx.createBuffer(1, floats.length, sampleRate);
  buffer.getChannelData(0).set(floats);
  
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  
  const now = ctx.currentTime;
  if (now < pcmStartTime) {
    source.start(pcmStartTime);
    pcmStartTime += buffer.duration;
  } else {
    source.start(now);
    pcmStartTime = now + buffer.duration;
  }
  pcmPlaying = true;
  
  source.onended = () => {
    if (ctx.currentTime >= pcmStartTime) {
      pcmPlaying = false;
    }
  };
}

export function interruptPcm() {
  
  pcmStartTime = 0;
  if (audioCtx) {
    audioCtx.suspend();
    setTimeout(() => {
      if (audioCtx) audioCtx.resume();
    }, 100);
  }
}

export function resetPcmStream() {
  pcmStartTime = 0;
  
  pcmPlaying = false;
}

export function livePcmPlaying() {
  return pcmPlaying;
}

export function onPcmInterrupted(cb: () => void) {
  // simple mock for now
  return () => {};
}
