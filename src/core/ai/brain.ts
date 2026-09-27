import type { Contact, PlaceCategory, ReplyLang } from '../types';
import type { ToolCall } from './tools';
import { P, type L } from './phrases';
import { wait } from '../util';

export interface BrainContext {
  sosActive: boolean;
  navigating: boolean;
  contacts: Contact[];
}

export interface BrainInput {
  text: string;
  lang: ReplyLang;
  context: BrainContext;
}

export interface BrainResult {
  calls: ToolCall[];
  reply?: L;
}

/** Anything that turns words into tool calls + a reply. Mock today, Gemini tomorrow. */
export interface AssistantBrain {
  respond(input: BrainInput): Promise<BrainResult>;
}

// ───────────────────────── language ─────────────────────────

const HINGLISH =
  /\b(kya|kyaa|hai|hain|mere|mera|meri|mujhe|kahan|kaha|kahaan|hoon|hun|chalo|bachao|batao|padho|padh|kitne|baje|ghar|aage|saamne|samne|kaun|karo|bhejo|bolo|dikhao|dekho|jana|jaana|paas)\b/i;

export function detectLang(text: string): ReplyLang {
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  if (HINGLISH.test(text)) return 'hi';
  return 'en';
}

// ───────────────────────── parsing helpers ─────────────────────────

const CATEGORIES: [PlaceCategory, RegExp][] = [
  ['mall', /\bmall\b|मॉल/i],
  ['pharmacy', /pharmacy|chemist|medical|medicine|dawa|दवा|फ़ार्मेसी|फार्मेसी|मेडिकल/i],
  ['hospital', /hospital|doctor|clinic|aspatal|अस्पताल|हॉस्पिटल|डॉक्टर/i],
  ['bus', /\bbus\b|बस स्टॉप|बस/i],
  ['atm', /\batm\b|\bbank\b|\bcash\b|एटीएम|बैंक/i],
  ['cafe', /cafe|café|coffee|\bchai\b|\btea\b|चाय|कैफ़े|कैफे|कॉफ़ी/i],
  ['home', /\bhome\b|\bghar\b|घर/i],
];

export const parseCategory = (t: string) => CATEGORIES.find(([, re]) => re.test(t))?.[0];

function parseContact(t: string, contacts: Contact[]): Contact | undefined {
  const lower = t.toLowerCase();
  return contacts.find((c) => c.aliases.some((a) => (/[a-z]/.test(a) ? new RegExp(`\\b${a}\\b`).test(lower) : lower.includes(a))));
}

function parseMessage(t: string): string {
  const m = t.match(/(?:tell|message|text|msg)\s+\S+\s+(?:that\s+)?(.+)/i);
  const body = m?.[1]?.trim();
  if (body && body.length > 2) return body.charAt(0).toUpperCase() + body.slice(1);
  return "I'm okay, reaching soon.";
}

/** Strict on purpose: "can you help me read this" must never start an SOS. */
export function isSos(t: string) {
  return /बचाओ|मदद करो|\bbachao\b|\bemergency\b|\bsos\b/i.test(t) || /^\s*(please\s+)?help(\s+me)?\s*[!.]*\s*$/i.test(t);
}

// ───────────────────────── mock interpreter ─────────────────────────

/**
 * Keyword interpreter that understands English, Hindi and Hinglish.
 * It doubles as the on-device fallback when there is no internet.
 */
export function interpret(raw: string, ctx: BrainContext): BrainResult {
  const t = raw.toLowerCase().trim();

  if (ctx.sosActive && /(cancel|i'?m (ok|okay|safe|fine)|theek|ठीक|रद्द|safe)/i.test(t)) return { calls: [{ name: 'cancel_sos' }] };
  if (isSos(t)) return { calls: [{ name: 'trigger_sos' }] };

  if (/(stop|cancel|end|band karo|ruko|ruk jao|रुको|बंद)/i.test(t) && (ctx.navigating || /nav|direction|route|rasta|रास्ता/i.test(t)))
    return { calls: [{ name: 'stop_navigation' }] };
  if (/(repeat|say that again|phir se|dobara|दोबारा|फिर से)/i.test(t)) return { calls: [{ name: 'repeat_last' }] };
  if (/(\bread\b|padho|padh ke|पढ़|पढ़ो)/i.test(t)) return { calls: [{ name: 'read_text' }] };
  if (/(\bnote\b|currency|rupee|kitne ka|नोट|रुपये)/i.test(t)) return { calls: [{ name: 'identify_currency' }] };
  if (/(where am i|kahan hoon|kaha hu|kahan hu|kahaan hoon|my location|कहाँ हूँ|कहां हूं|कहाँ हूं|कहां हूँ)/i.test(t))
    return { calls: [{ name: 'where_am_i' }] };

  const category = parseCategory(t);
  const goVerb = /(take me|go to|navigate|direction|nearest|nearby|le chalo|jana|jaana|chalna|ले चलो|जाना|चलो|पास|paas|how do i get|rasta|रास्ता)/i.test(t);
  if (category && (goVerb || t.split(/\s+/).length <= 3)) return { calls: [{ name: 'navigate_to', args: { category } }] };
  if (goVerb && /(take me|go to|navigate|le chalo|ले चलो)/i.test(t)) return { calls: [{ name: 'navigate_to', args: { query: raw } }] };

  if (/(in front|ahead|what do you see|what's there|describe|look around|aage|saamne|samne|सामने|आगे|dekho|देखो)/i.test(t))
    return { calls: [{ name: 'describe_scene' }] };

  const contact = parseContact(t, ctx.contacts);
  if (/(message|\btext\b|\bmsg\b|\btell\b|bhejo|bata do|बता दो|मैसेज|भेजो)/i.test(t))
    return { calls: [{ name: 'send_message', args: { contact: contact?.id ?? '', text: parseMessage(raw) } }] };
  if (/(\bcall\b|\bphone\b|\bdial\b|कॉल|फ़ोन|फोन|baat karao|baat karni)/i.test(t))
    return { calls: [{ name: 'call_contact', args: { contact: contact?.id ?? '' } }] };
  if (/(battery|charge|charging|बैटरी|connected)/i.test(t)) return { calls: [{ name: 'get_status' }] };
  if (/(\btime\b|kitne baje|samay|टाइम|समय|बजे)/i.test(t)) return { calls: [{ name: 'get_time' }] };

  return { calls: [], reply: P.fallback };
}

export const mockBrain: AssistantBrain = {
  async respond({ text, context }) {
    await wait(520 + Math.random() * 420);
    return interpret(text, context);
  },
};

/**
 * DEMO MODE ONLY. Real mode never uses this brain: core/ai/realAssistant.ts talks to the
 * `assistantTurn` Cloud Function (Gemini) and core/ai/executor.ts runs the validated tools.
 */
export const brain: AssistantBrain = mockBrain;
