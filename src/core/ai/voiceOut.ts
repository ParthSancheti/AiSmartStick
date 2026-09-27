import type { ReplyLang } from '../types';
import { useAssistant } from '../store/assistant';
import { getSettings } from '../store/session';
import { say, type Priority } from '../audio/audioManager';
import { userSurfaceActive } from '../surfaces';
import { abortRecognition } from '../voice/recognition';
import type { L } from './phrases';

export function resolveLang(): ReplyLang {
  const pref = getSettings().replyLang;
  return pref === 'auto' ? useAssistant.getState().lang : pref;
}

/** Assistant speech: shown as a caption and spoken through the unified audio orchestrator (P2 by default). */
export async function speakReply(text: string, lang: ReplyLang, priority: Priority = 'user') {
  useAssistant.setState({ phase: 'speaking', reply: text, lastSpoken: { text, lang } });
  const r = userSurfaceActive() ? await say(text, { lang, priority }) : 'spoken';
  const a = useAssistant.getState();
  if (a.reply !== text) return;
  if (r === 'interrupted') {
    useAssistant.setState({ phase: 'interrupted' });
    setTimeout(() => useAssistant.getState().phase === 'interrupted' && useAssistant.setState({ phase: 'idle' }), 1500);
  } else if (a.phase === 'speaking' || a.phase === 'error') useAssistant.setState({ phase: 'idle' });
}

/**
 * System announcements (turns, disconnects, SOS, guardian messages). Normal ones wait
 * until the assistant isn't listening or thinking; high/critical ones interrupt.
 */
export function announce(line: L | string, opts: { high?: boolean; critical?: boolean; nav?: boolean; lang?: ReplyLang; dedupeKey?: string } = {}, tries = 0) {
  const lang = opts.lang ?? resolveLang();
  const text = typeof line === 'string' ? line : line[lang];
  const phase = useAssistant.getState().phase;
  const urgent = opts.high || opts.critical;
  if (!urgent && (phase === 'listening' || phase === 'thinking') && tries < 8) {
    setTimeout(() => announce(line, opts, tries + 1), 1200);
    return;
  }
  if (urgent && phase === 'listening') abortRecognition();
  const priority: Priority = opts.critical ? 'critical' : opts.high ? 'high' : opts.nav ? 'nav' : 'normal';
  // System announcements don't take over the assistant caption/phase; they only speak.
  if (!userSurfaceActive()) return;
  void say(text, { lang, priority, dedupeKey: opts.dedupeKey });
}
