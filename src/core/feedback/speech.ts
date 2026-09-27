import type { ReplyLang } from '../types';
import { say, stopAll } from '../audio/audioManager';

/** Compatibility wrappers: all speech goes through the central audio manager. */
export function speak(text: string, lang: ReplyLang = 'en') {
  return say(text, { lang, priority: 'normal' }).then(() => undefined);
}

export function stopSpeaking() {
  void stopAll();
}
