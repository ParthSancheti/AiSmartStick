import { Capacitor } from '@capacitor/core';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import type { ReplyLang } from '../types';

/**
 * Text-to-speech engines. Native (Android TTS, follows the system audio route, so Bluetooth
 * earbuds work) inside the app; Web Speech in a browser. Both honour rate and volume.
 */
export interface TtsEngine {
  readonly name: 'native' | 'web' | 'none';
  speak(text: string, o: { lang: ReplyLang; rate: number; volume: number }): Promise<void>;
  stop(): Promise<void>;
}

const tag = (lang: ReplyLang) => (lang === 'hi' ? 'hi-IN' : 'en-IN');

export function pickVoiceIndex(voices: { name?: string; voiceURI?: string; lang?: string }[], lang: string, online: boolean): number | undefined {
  // Google's natural "network" voices (neural) when online, else the best offline Google voice.
  const want = lang.toLowerCase();
  let bestI: number | undefined;
  let bestScore = -Infinity;
  voices.forEach((v, i) => {
    const l = (v.lang ?? '').replace('_', '-').toLowerCase();
    if (!l.startsWith(want.slice(0, 2))) return;
    const n = `${v.name ?? ''} ${v.voiceURI ?? ''}`.toLowerCase();
    let score = l === want ? 100 : want.startsWith('en') && /en-(gb|us)/.test(l) ? 40 : 20;
    if (/network/.test(n)) score += online ? 30 : -50;
    if (/local/.test(n)) score += 10;
    if (/-x-/.test(n)) score += 5;
    if (/legacy|compact|espeak|pico/.test(n)) score -= 60;
    if (score > bestScore) {
      bestScore = score;
      bestI = i;
    }
  });
  return bestI;
}

class NativeTts implements TtsEngine {
  readonly name = 'native' as const;
  private voices: Promise<SpeechSynthesisVoice[]> | null = null;
  private async voiceFor(lang: string) {
    this.voices ??= TextToSpeech.getSupportedVoices()
      .then((r) => r.voices ?? [])
      .catch(() => []);
    return pickVoiceIndex(await this.voices, lang, typeof navigator === 'undefined' || navigator.onLine !== false);
  }
  async speak(text: string, o: { lang: ReplyLang; rate: number; volume: number }) {
    const lang = tag(o.lang);
    const voice = await this.voiceFor(lang).catch(() => undefined);
    // A touch slower than the engine default: calmer for spoken guidance.
    const rate = Math.max(0.5, Math.min(2, o.rate * 0.95));
    try {
      await TextToSpeech.speak({ text, lang, rate, volume: o.volume, pitch: 1.0, category: 'playback', ...(voice != null ? { voice } : {}) });
    } catch (e) {
      if (voice == null) throw e;
      await TextToSpeech.speak({ text, lang, rate, volume: o.volume, pitch: 1.0, category: 'playback' });
    }
  }
  async stop() {
    await TextToSpeech.stop();
  }
}

class WebTts implements TtsEngine {
  readonly name = 'web' as const;
  private voices: SpeechSynthesisVoice[] = [];
  constructor() {
    const load = () => (this.voices = window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener?.('voiceschanged', load);
  }
  private pick(lang: string) {
    if (!this.voices.length) this.voices = window.speechSynthesis.getVoices();
    const exact = this.voices.filter((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase());
    if (exact.length) return exact.find((v) => /google|natural|neural/i.test(v.name)) ?? exact[0];
    const fam = this.voices.filter((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)));
    return fam.find((v) => /en-(in|gb)/i.test(v.lang)) ?? fam[0];
  }
  speak(text: string, o: { lang: ReplyLang; rate: number; volume: number }) {
    return new Promise<void>((resolve) => {
      const s = window.speechSynthesis;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = tag(o.lang);
      const v = this.pick(u.lang);
      if (v) u.voice = v;
      u.rate = o.rate;
      u.volume = o.volume;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve();
      };
      // Some engines never fire onend; never leave the assistant stuck in "speaking".
      const guard = setTimeout(finish, Math.min(20000, 1500 + (text.length * 90) / o.rate));
      u.onend = finish;
      u.onerror = finish;
      s.speak(u);
    });
  }
  async stop() {
    window.speechSynthesis.cancel();
  }
}

class NoTts implements TtsEngine {
  readonly name = 'none' as const;
  async speak(text: string, o: { rate: number }) {
    await new Promise((r) => setTimeout(r, Math.min(9000, 600 + (text.length * 55) / o.rate)));
  }
  async stop() {}
}

let engine: TtsEngine | null = null;
export function ttsEngine(): TtsEngine {
  if (engine) return engine;
  if (Capacitor.isNativePlatform()) engine = new NativeTts();
  else if (typeof window !== 'undefined' && 'speechSynthesis' in window) engine = new WebTts();
  else engine = new NoTts();
  return engine;
}
