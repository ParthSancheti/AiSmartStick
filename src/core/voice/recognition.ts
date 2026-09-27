import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';

/**
 * Speech-to-text, push-to-talk (one utterance per press).
 *  - Android app: native recognizer via @capacitor-community/speech-recognition.
 *  - Browser: Web Speech API (Chrome sends audio to Google; needs internet).
 * Every session is torn down on abort so the microphone never stays open.
 */
type AnyRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

let rec: AnyRec | null = null;
let nativeHandles: PluginListenerHandle[] = [];
let nativeActive = false;

function ctor(): (new () => AnyRec) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => AnyRec; webkitSpeechRecognition?: new () => AnyRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const native = () => Capacitor.isNativePlatform();

export const recognitionSupported = () => native() || !!ctor();

interface Opts {
  lang: string;
  onInterim: (t: string) => void;
  onFinal: (t: string) => void;
  onError: (code: string) => void;
}

async function startNative(o: Opts) {
  try {
    const perm = await SpeechRecognition.checkPermissions();
    if (perm.speechRecognition !== 'granted') {
      const r = await SpeechRecognition.requestPermissions();
      if (r.speechRecognition !== 'granted') return o.onError('not-allowed');
    }
    let last = '';
    nativeActive = true;
    nativeHandles.push(
      await SpeechRecognition.addListener('partialResults', (d: { matches?: string[] }) => {
        last = d.matches?.[0] ?? last;
        o.onInterim(last);
      }),
      await SpeechRecognition.addListener('listeningState', (d: { status: 'started' | 'stopped' }) => {
        if (d.status !== 'stopped' || !nativeActive) return;
        nativeActive = false;
        void clearNative();
        if (last.trim()) o.onFinal(last.trim());
        else o.onError('no-speech');
      }),
    );
    await SpeechRecognition.start({ language: o.lang, maxResults: 1, partialResults: true, popup: false });
  } catch {
    nativeActive = false;
    void clearNative();
    o.onError('audio-capture');
  }
}

async function clearNative() {
  const h = nativeHandles;
  nativeHandles = [];
  await Promise.all(h.map((x) => x.remove().catch(() => undefined)));
}

export function startRecognition(o: Opts): boolean {
  abortRecognition();
  if (native()) {
    void startNative(o);
    return true;
  }
  const C = ctor();
  if (!C) return false;
  const r = new C();
  r.lang = o.lang;
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  let finalText = '';
  let failed = false;
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    o.onInterim((finalText + interim).trim());
  };
  r.onerror = (e) => {
    failed = true;
    o.onError(e.error);
  };
  r.onend = () => {
    if (rec === r) rec = null;
    if (failed) return;
    if (finalText.trim()) o.onFinal(finalText.trim());
    else o.onError('no-speech');
  };
  try {
    r.start();
    rec = r;
    return true;
  } catch {
    return false;
  }
}

export function abortRecognition() {
  if (nativeActive) {
    nativeActive = false;
    void SpeechRecognition.stop().catch(() => undefined);
    void clearNative();
  }
  if (!rec) return;
  const r = rec;
  rec = null;
  r.onend = null;
  r.onerror = null;
  try {
    r.abort();
  } catch {
    /* noop */
  }
}
