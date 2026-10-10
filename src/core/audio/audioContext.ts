/**
 * The ONE Web Audio context of the app (earcons, the connecting tune, the Gemini Live voice).
 *
 * Why one: Android WebView / Chrome start an AudioContext "suspended" unless it is created or
 * resumed after the user has touched the page. A context unlocked by the first tap stays unlocked,
 * so everything that shares it can make sound later without a gesture (e.g. when the assistant is
 * started from the stick's button over Wi-Fi). Separate contexts created later may stay silent.
 *
 * The microphone uses its own 16 kHz context (core/voice/micStream.ts); that one is input only.
 */
let ctx: AudioContext | null = null;
let installed = false;

type Ctor = typeof AudioContext;

function ctor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext ?? null;
}

/** Asks a suspended/interrupted context to run. Never throws; resolves when done or refused. */
export function resumeAudio(): Promise<void> {
  const c = ctx;
  if (!c || c.state === 'running' || c.state === 'closed') return Promise.resolve();
  try {
    return Promise.resolve(c.resume()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

/** The shared context (created on first use), or null where Web Audio does not exist. */
export function sharedAudioContext(): AudioContext | null {
  if (ctx && ctx.state === 'closed') ctx = null;
  if (!ctx) {
    const C = ctor();
    if (!C) return null;
    try {
      ctx = new C();
    } catch {
      return null;
    }
    installAudioUnlock();
  }
  if (ctx.state !== 'running') void resumeAudio();
  return ctx;
}

/** True when sound scheduled on the shared context is audible right now. */
export function audioContextRunning(): boolean {
  return !!ctx && ctx.state === 'running';
}

/**
 * Call from inside a user gesture (tap, key). Creates/resumes the shared context and plays one
 * silent sample, which is what unlocks audio on Android WebView and mobile Chrome.
 */
export function unlockAudioContext() {
  const c = sharedAudioContext();
  if (!c) return;
  try {
    const b = c.createBuffer(1, 1, c.sampleRate || 22050);
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(c.destination);
    s.start(0);
  } catch {
    /* some engines refuse before the context runs; resume() above still counts */
  }
}

/**
 * Keeps the context unlocked: every tap/key until it runs, and again when the app returns to the
 * foreground (Android suspends WebView audio in the background).
 */
export function installAudioUnlock() {
  if (installed || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  installed = true;
  const onGesture = () => {
    if (!ctx || ctx.state !== 'running') unlockAudioContext();
  };
  for (const ev of ['pointerdown', 'touchend', 'keydown', 'click'] as const) window.addEventListener(ev, onGesture, { capture: true, passive: true });
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void resumeAudio();
    });
  }
}

/** Tests only. */
export function __resetAudioContextForTests() {
  ctx = null;
  installed = false;
}
