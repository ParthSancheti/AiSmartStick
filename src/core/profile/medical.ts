import { doc, getDoc, setDoc } from 'firebase/firestore';
import { fb } from '../firebase/app';
import { paths } from '../../../shared/firestoreSchema';
import { currentUid } from '../auth/authStore';
import { isDemo } from '../runtime/mode';

/**
 * Medical profile: users/{uid}/medical/profile. Written only by the user; readable by the linked
 * guardian with the `sos` permission (firestore.rules). Never logged, never sent to Gemini.
 * All fields optional (progressive profile).
 */
export interface MedicalProfile {
  bloodGroup: string;
  allergies: string;
  medications: string;
  conditions: string;
  notes: string;
  updatedAt: number;
}

export const emptyMedical = (): MedicalProfile => ({ bloodGroup: '', allergies: '', medications: '', conditions: '', notes: '', updatedAt: 0 });
const ref = (uid: string) => doc(fb().db, `${paths.user(uid)}/medical/profile`);

export async function loadMedical(uid = currentUid()): Promise<MedicalProfile | null> {
  if (!uid || isDemo()) return null;
  const s = await getDoc(ref(uid));
  return s.exists() ? ({ ...emptyMedical(), ...(s.data() as Partial<MedicalProfile>) } as MedicalProfile) : null;
}

export async function saveMedical(m: Omit<MedicalProfile, 'updatedAt'>) {
  const uid = currentUid();
  if (!uid || isDemo()) return;
  const clean = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, String(v ?? '').trim().slice(0, 300)]));
  await setDoc(ref(uid), { ...clean, updatedAt: Date.now() });
}
