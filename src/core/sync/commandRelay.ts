import { collection, doc, limit, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths } from '../../../shared/firestoreSchema';
import { getTransport } from '../device/bridge';
import { useDevice, isLinked } from '../store/device';
import { useSession } from '../store/session';
import { logEvent } from '../store/activity';
import { announce } from '../ai/voiceOut';
import { runVision } from '../ai/executor';
import { log } from '../log';

/**
 * USER PHONE side of Guardian remote commands: queued → received → executing → completed/failed/expired.
 * The phone is the only path to the stick. Each command id is used as the device commandId, so a
 * retried or duplicated relay never makes the stick act twice.
 */
export interface RemoteCommandDoc {
  commandId: string;
  type: 'locate' | 'nudge' | 'scan';
  issuedBy: string;
  createdAt: number;
  expiresAt: number;
  status: 'queued' | 'received' | 'executing' | 'completed' | 'failed' | 'expired';
  result: Record<string, unknown> | null;
  error: string | null;
}

let unsub: (() => void) | null = null;
const inFlight = new Set<string>();

export function startCommandRelay(uid: string) {
  unsub?.();
  const col = collection(fb().db, `${paths.user(uid)}/deviceCommands`);
  unsub = onSnapshot(query(col, where('status', '==', 'queued'), limit(5)), (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type !== 'added' || inFlight.has(ch.doc.id)) return;
      inFlight.add(ch.doc.id);
      void execute(uid, ch.doc.data() as RemoteCommandDoc).finally(() => inFlight.delete(ch.doc.id));
    });
  });
}

export function stopCommandRelay() {
  unsub?.();
  unsub = null;
}

async function execute(uid: string, c: RemoteCommandDoc) {
  const ref = doc(fb().db, `${paths.user(uid)}/deviceCommands/${c.commandId}`);
  const set = (p: Partial<RemoteCommandDoc>) => updateDoc(ref, { ...p, updatedAt: Date.now() }).catch((e) => log.warn('command status write failed', { e: String(e) }));
  if (Date.now() > c.expiresAt) return set({ status: 'expired' });
  await set({ status: 'received' });
  const who = useSession.getState().guardian.heardAs || 'Your guardian';
  const t = getTransport();
  try {
    if (c.type === 'scan') {
      announce({ en: `${who} asked for a description of what is in front of you.`, hi: `${who} ने आपके सामने का विवरण माँगा है।` }, { high: true });
      await set({ status: 'executing' });
      const r = await runVision('describe_scene');
      announce(r.spoken);
      logEvent({ kind: 'vision', severity: 'info', title: `${who} requested an AI scan`, detail: r.uncertain ? 'Result was uncertain' : undefined });
      // Only the text summary goes back — never the photo.
      return set({ status: 'completed', result: { spoken: r.spoken, uncertain: r.uncertain, hazards: r.hazards.length } });
    }
    if (!t || !isLinked(useDevice.getState().link)) return set({ status: 'failed', error: 'The stick is not connected to the phone.' });
    await set({ status: 'executing' });
    const ack = await t.send({ type: c.type }, { commandId: c.commandId, ttlMs: Math.max(1000, c.expiresAt - Date.now()) });
    const ok = ack.status === 'completed' || ack.status === 'duplicate';
    if (c.type === 'nudge' && ok) announce({ en: `${who} sent you a nudge.`, hi: `${who} ने आपको याद किया।` });
    logEvent({ kind: 'device', severity: ok ? 'info' : 'warning', title: `${who} ${c.type === 'locate' ? 'used Find Stick' : 'sent a nudge'}`, detail: ok ? 'The stick vibrated' : `Not done: ${ack.error ?? ack.status}` });
    return set(ok ? { status: 'completed', result: { device: ack.status } } : { status: ack.status === 'expired' ? 'expired' : 'failed', error: ack.error ?? ack.status });
  } catch (e) {
    const m = (e as Error).message;
    return set({ status: 'failed', error: m === 'stick-offline' ? 'The stick is not connected to the phone.' : m });
  }
}
