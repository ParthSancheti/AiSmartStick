import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths } from '../../../shared/firestoreSchema';
import { currentUid } from '../auth/authStore';
import { isDemo } from '../runtime/mode';
import { useAssistant } from '../store/assistant';

/** Conversation history. Real: Firestore (written by the assistant backend). Demo: this session only. */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  ts: number;
}

export async function listConversations(max = 30): Promise<ConversationSummary[]> {
  if (isDemo()) {
    const t = useAssistant.getState().thread;
    const first = t.find((m) => m.role === 'user');
    return first ? [{ id: 'demo', title: first.text, updatedAt: t[t.length - 1].ts }] : [];
  }
  const uid = currentUid();
  if (!uid) return [];
  const snap = await getDocs(query(collection(fb().db, paths.conversations(uid)), orderBy('updatedAt', 'desc'), limit(max)));
  return snap.docs.map((d) => ({ id: d.id, title: (d.data().title as string) || 'Conversation', updatedAt: d.data().updatedAt as number }));
}

export async function loadMessages(conversationId: string, max = 50): Promise<StoredMessage[]> {
  if (isDemo()) return useAssistant.getState().thread.filter((m) => m.role !== 'system').map((m) => ({ id: m.id, role: m.role === 'assistant' ? 'model' : 'user', text: m.text, ts: m.ts }));
  const uid = currentUid();
  if (!uid) return [];
  const snap = await getDocs(query(collection(fb().db, paths.messages(uid, conversationId)), orderBy('ts', 'desc'), limit(max)));
  return snap.docs
    .map((d) => ({ id: d.id, role: d.data().role as 'user' | 'model', text: (d.data().text as string) ?? '', ts: d.data().ts as number }))
    .filter((m) => m.text)
    .reverse();
}
