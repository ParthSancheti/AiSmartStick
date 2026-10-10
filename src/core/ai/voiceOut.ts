import type { ReplyLang } from '../types';
import { useAssistant } from '../store/assistant';
import { getSettings } from '../store/session';
import { say, liveAudioActive, livePcmPlaying, discardInvalidSpeech, type Priority } from '../audio/audioManager';
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
export interface AnnouncementOptions {
  high?: boolean;
  critical?: boolean;
  nav?: boolean;
  lang?: ReplyLang;
  dedupeKey?: string;
  isCurrent?: () => boolean;
}
const pendingAnnouncements = new Map<string, { timer: ReturnType<typeof setTimeout>; opts: AnnouncementOptions }>();

/** Cancel obsolete retry timers and queued/current owned speech without stopping a conversation. */
export function cancelInvalidAnnouncements() {
  for (const [key, pending] of pendingAnnouncements) {
    if (pending.opts.isCurrent && !pending.opts.isCurrent()) {
      clearTimeout(pending.timer);
      pendingAnnouncements.delete(key);
    }
  }
  discardInvalidSpeech();
}

export function announce(line: L | string, opts: AnnouncementOptions = {}) {
  if (opts.isCurrent && !opts.isCurrent()) return;
  if (opts.dedupeKey) {
    const previous = pendingAnnouncements.get(opts.dedupeKey);
    if (previous) clearTimeout(previous.timer);
    pendingAnnouncements.delete(opts.dedupeKey);
  }
  attemptAnnouncement(line, opts, 0);
}

function attemptAnnouncement(line: L | string, opts: AnnouncementOptions, tries: number) {
  if (opts.isCurrent && !opts.isCurrent()) return;
  const lang = opts.lang ?? resolveLang();
  const text = typeof line === 'string' ? line : line[lang];
  const phase = useAssistant.getState().phase;
  const urgent = opts.high || opts.critical;
  const retry = (delayMs: number) => {
    const timer = setTimeout(() => {
      if (opts.dedupeKey) {
        if (pendingAnnouncements.get(opts.dedupeKey)?.timer !== timer) return;
        pendingAnnouncements.delete(opts.dedupeKey);
      }
      attemptAnnouncement(line, opts, tries + 1);
    }, delayMs);
    if (opts.dedupeKey) pendingAnnouncements.set(opts.dedupeKey, { timer, opts });
  };
  if (!urgent && opts.nav && liveAudioActive()) {
    // Let the current Live sentence finish, then keep the existing turn-by-turn priority policy.
    if (livePcmPlaying() && tries < 6) {
      retry(800);
      return;
    }
  } else if (!urgent && (phase === 'listening' || phase === 'thinking') && tries < 8) {
    retry(1200);
    return;
  }
  if (urgent && phase === 'listening') abortRecognition();
  const priority: Priority = opts.critical ? 'critical' : opts.high ? 'high' : opts.nav ? 'nav' : 'normal';
  if (!userSurfaceActive()) return;
  void say(text, { lang, priority, dedupeKey: opts.dedupeKey, isCurrent: opts.isCurrent });
}
