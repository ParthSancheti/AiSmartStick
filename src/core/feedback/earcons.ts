import { getSettings } from '../store/session';
import { audioVolume } from '../audio/audioManager';

/**
 * Earcons: short synthesized sounds that mean the same thing every time.
 * For someone who can't see the screen, these are what icons are for everyone else.
 */
let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function unlockAudio() {
  ac();
}

interface ToneOpts { type?: OscillatorType; gain?: number; to?: number }

function tone(freq: number, at: number, dur: number, o: ToneOpts = {}) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, (o.gain ?? 0.12) * audioVolume()), t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

const LIB = {
  connect: () => { tone(660, 0, 0.12); tone(990, 0.1, 0.18); },
  disconnect: () => { tone(740, 0, 0.14, { type: 'triangle' }); tone(440, 0.13, 0.26, { type: 'triangle' }); },
  listen: () => tone(520, 0, 0.16, { to: 880, gain: 0.1 }),
  cancel: () => tone(700, 0, 0.14, { to: 420, gain: 0.08 }),
  success: () => { tone(784, 0, 0.12); tone(1175, 0.09, 0.2); },
  warning: () => { tone(440, 0, 0.12, { type: 'square', gain: 0.05 }); tone(440, 0.18, 0.12, { type: 'square', gain: 0.05 }); },
  alert: () => { tone(880, 0, 0.18, { type: 'sawtooth', gain: 0.06 }); tone(660, 0.2, 0.18, { type: 'sawtooth', gain: 0.06 }); },
  tick: () => tone(1200, 0, 0.05, { gain: 0.07 }),
  sent: () => { tone(523, 0, 0.14); tone(659, 0.12, 0.14); tone(1047, 0.24, 0.3); },
  turn: () => tone(600, 0, 0.14, { to: 820, gain: 0.09 }),
  arrive: () => { tone(523, 0, 0.3, { gain: 0.07 }); tone(659, 0.02, 0.3, { gain: 0.07 }); tone(784, 0.04, 0.4, { gain: 0.07 }); },
  viewing: () => { tone(988, 0, 0.1, { gain: 0.06 }); tone(1319, 0.1, 0.16, { gain: 0.06 }); },
  message: () => { tone(880, 0, 0.1, { gain: 0.07 }); tone(1109, 0.12, 0.18, { gain: 0.07 }); },
};

export type EarconName = keyof typeof LIB;

export function earcon(name: EarconName) {
  if (!getSettings().earcons) return;
  LIB[name]();
}

/** Looping sounds. Returns a stop function. */
export function loopEarcon(name: 'thinking' | 'siren' | 'connecting'): () => void {
  if (!getSettings().earcons) return () => {};
  const c = ac();
  if (!c) return () => {};

  if (name === 'connecting') {
    const play = () => {
      tone(440, 0, 0.4, { type: 'sine', gain: 0.04 });
      tone(440, 0.8, 0.4, { type: 'sine', gain: 0.04 });
    };
    play();
    const id = setInterval(play, 2400); // ringing tone
    return () => clearInterval(id);
  }

  if (name === 'thinking') {
    const play = () => {
      tone(523, 0, 0.22, { gain: 0.03 });
      tone(659, 0.16, 0.22, { gain: 0.03 });
      tone(784, 0.32, 0.3, { gain: 0.03 });
    };
    play();
    const id = setInterval(play, 1300);
    return () => clearInterval(id);
  }

  // Siren: sweeping oscillator with an LFO on frequency.
  const osc = c.createOscillator();
  const lfo = c.createOscillator();
  const lfoGain = c.createGain();
  const out = c.createGain();
  osc.type = 'sawtooth';
  osc.frequency.value = 880;
  lfo.frequency.value = 1.4;
  lfoGain.gain.value = 260;
  out.gain.value = 0.0001;
  out.gain.exponentialRampToValueAtTime(0.06, c.currentTime + 0.2); // siren ignores assistant volume on purpose
  lfo.connect(lfoGain).connect(osc.frequency);
  osc.connect(out).connect(c.destination);
  osc.start();
  lfo.start();
  return () => {
    const t = c.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(out.gain.value, t);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.stop(t + 0.3);
    lfo.stop(t + 0.3);
  };
}

/**
 * Pocket-mode keep-alive: a silent audio graph. On some Android browsers a page
 * that is "playing audio" is throttled less in the background. It is a hack, not
 * a guarantee; the native build uses a foreground service instead.
 */
export function startSilentKeepAlive(): () => void {
  const c = ac();
  if (!c) return () => {};
  const osc = c.createOscillator();
  const g = c.createGain();
  g.gain.value = 0.00001;
  osc.connect(g).connect(c.destination);
  osc.start();
  return () => osc.stop();
}
