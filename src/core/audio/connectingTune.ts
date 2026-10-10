import { getSettings } from '../store/session';
import { audioVolume, useAudio } from './audioManager';
import { sharedAudioContext, resumeAudio } from './audioContext';

/**
 * "Connecting…" tune for the AI assistant: a soft four-note chime (E5 G5 C6 G5) that loops every
 * 1.6 s while Gemini Live is connecting, and stops the moment the session is open (or fails,
 * is cancelled, SOS starts, …). Only ONE tune can exist at a time; starting a new one stops the old.
 *
 * Reliability on Android WebView:
 *  1. Web Audio on the app's shared context (unlocked by the first tap, core/audio/audioContext.ts):
 *     one pre-rendered buffer looping sample-accurately (no setInterval → no stutter when the
 *     WebView is busy).
 *  2. If that context is not running shortly after start (audio still locked, e.g. the stick button
 *     was pressed before the screen was ever touched), the same tune plays from an <audio> element
 *     with a WAV data URI, which Capacitor's WebView allows without a gesture.
 * It pauses while the app is speaking (no overlap with TTS) and has a hard cap so it never leaks.
 */
export const PHRASE_S = 1.6;
/** Peak level before the user's assistant volume (earcons use ~0.1; this must be clearly audible). */
export const TUNE_GAIN = 0.32;
/** Never ring longer than this, whatever happens to the caller. */
export const MAX_TUNE_MS = 45_000;
/** How long Web Audio gets to start before the <audio> fallback takes over. */
export const FALLBACK_AFTER_MS = 300;
const WAV_RATE = 22_050;

const NOTES: { f: number; at: number }[] = [
  { f: 659.25, at: 0 },
  { f: 783.99, at: 0.2 },
  { f: 1046.5, at: 0.4 },
  { f: 783.99, at: 0.6 },
];
const NOTE_LEN_S = 0.9;

/** The phrase as mono samples (peak 0.9, silent at both ends so the loop is click-free). */
export function renderPhrase(sampleRate: number): Float32Array {
  const n = Math.round(PHRASE_S * sampleRate);
  const out = new Float32Array(n);
  const attack = 0.01;
  const fade = 0.05;
  for (const { f, at } of NOTES) {
    const start = Math.round(at * sampleRate);
    const len = Math.min(n - start, Math.round(NOTE_LEN_S * sampleRate));
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      let env = t < attack ? t / attack : Math.exp(-(t - attack) / 0.2);
      if (t > NOTE_LEN_S - fade) env *= Math.max(0, (NOTE_LEN_S - t) / fade);
      const w = 2 * Math.PI * f * t;
      // Fundamental + a little 2nd/3rd harmonic: carries on small phone speakers, still soft.
      out[start + i] += env * (Math.sin(w) + 0.3 * Math.sin(2 * w) + 0.08 * Math.sin(3 * w));
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * 0.9;
  return out;
}

/** 16-bit mono PCM WAV as a data: URI. */
export function encodeWavDataUri(samples: Float32Array, sampleRate: number): string {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

let wavUri: string | null = null;
const wav = () => (wavUri ??= encodeWavDataUri(renderPhrase(WAV_RATE), WAV_RATE));
const buffers = new WeakMap<AudioContext, AudioBuffer>();

interface Player {
  readonly kind: 'webaudio' | 'element';
  setLevel(level: number): void;
  stop(): void;
}

function webAudioPlayer(c: AudioContext, level: number): Player | null {
  try {
    let buf = buffers.get(c);
    if (!buf) {
      const data = renderPhrase(c.sampleRate);
      buf = c.createBuffer(1, data.length, c.sampleRate);
      buf.getChannelData(0).set(data);
      buffers.set(c, buf);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = c.createGain();
    g.gain.value = level;
    src.connect(g);
    g.connect(c.destination);
    src.start();
    let done = false;
    return {
      kind: 'webaudio',
      setLevel(l) {
        if (done) return;
        const t = c.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(l, t + 0.04);
      },
      stop() {
        if (done) return;
        done = true;
        try {
          const t = c.currentTime;
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(g.gain.value, t);
          g.gain.linearRampToValueAtTime(0, t + 0.03);
          src.stop(t + 0.04);
        } catch {
          try {
            src.stop();
          } catch {
            /* already stopped */
          }
        }
        src.onended = () => {
          try {
            src.disconnect();
            g.disconnect();
          } catch {
            /* ignore */
          }
        };
      },
    };
  } catch {
    return null;
  }
}

function elementPlayer(level: number): Player | null {
  if (typeof Audio === 'undefined') return null;
  try {
    const el = new Audio(wav());
    el.loop = true;
    el.volume = Math.max(0, Math.min(1, level));
    let done = false;
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
    return {
      kind: 'element',
      setLevel(l) {
        if (!done) el.volume = Math.max(0, Math.min(1, l));
      },
      stop() {
        if (done) return;
        done = true;
        try {
          el.pause();
          el.removeAttribute('src');
          el.load();
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return null;
  }
}

const noop = () => {};
let activeStop: (() => void) | null = null;
let activeKind: Player['kind'] | null = null;

/** True while a connecting tune is playing (tests, diagnostics). */
export function connectingTunePlaying() {
  return activeStop !== null;
}

/** Which engine the current tune uses ('webaudio' | 'element'), or null. */
export function connectingTuneEngine() {
  return activeKind;
}

/** Stops the current tune, if any. Safe to call any time. */
export function stopConnectingTune() {
  activeStop?.();
}

/** Starts the looping tune. Returns its stop function (idempotent). */
export function startConnectingTune(): () => void {
  stopConnectingTune();
  if (typeof window === 'undefined') return noop;
  if (!getSettings().earcons) return noop;
  const level = TUNE_GAIN * audioVolume();
  if (level <= 0) return noop;

  let stopped = false;
  let player: Player | null = null;
  let ducked = useAudio.getState().speaking;
  const lvl = () => (ducked ? 0 : level);

  const c = sharedAudioContext();
  if (c) player = webAudioPlayer(c, lvl());
  if (!player) player = elementPlayer(lvl());
  activeKind = player?.kind ?? null;

  // Web Audio still locked shortly after start: switch to the <audio> element.
  const fallback =
    c && player?.kind === 'webaudio'
      ? setTimeout(() => {
          if (stopped || c.state === 'running') return;
          void resumeAudio();
          const el = elementPlayer(lvl());
          if (!el) return;
          player?.stop();
          player = el;
          activeKind = 'element';
        }, FALLBACK_AFTER_MS)
      : undefined;

  // Never talk over the app's speech: silence the tune while the audio owner is speaking.
  const unsub = useAudio.subscribe((s) => {
    if (s.speaking === ducked) return;
    ducked = s.speaking;
    player?.setLevel(lvl());
  });

  const cap = setTimeout(() => stop(), MAX_TUNE_MS);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(cap);
    clearTimeout(fallback);
    unsub();
    player?.stop();
    player = null;
    if (activeStop === stop) {
      activeStop = null;
      activeKind = null;
    }
  }
  activeStop = stop;
  return stop;
}
