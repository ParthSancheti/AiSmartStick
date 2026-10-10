import { create } from 'zustand';
import type { AssistantPhase, ReplyLang, ToolCard } from '../types';

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
}

interface AssistantData {
  phase: AssistantPhase;
  heard: string;
  reply: string;
  lang: ReplyLang;
  card: ToolCard | null;
  lastSpoken: { text: string; lang: ReplyLang } | null;
  /** Messages of the current conversation (both modes); real history also lives in Firestore. */
  thread: ThreadMessage[];
  conversationId: string | null;
  /** Why the assistant can't work right now (offline, backend error, not configured). */
  unavailable: string | null;
  awaitingConfirmation: string | null;
}

export const useAssistant = create<AssistantData>(() => ({
  phase: 'idle',
  heard: '',
  reply: '',
  lang: 'en',
  card: null,
  lastSpoken: null,
  thread: [],
  conversationId: null,
  unavailable: null,
  awaitingConfirmation: null,
}));

export function pushThread(role: ThreadMessage['role'], text: string) {
  const m: ThreadMessage = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, role, text, ts: Date.now() };
  useAssistant.setState((s) => ({ thread: [...s.thread, m].slice(-60) }));
}
