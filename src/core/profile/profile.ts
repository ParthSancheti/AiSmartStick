import { useAuth } from '../auth/authStore';
import { useSession, type Person, type SavedPlace } from '../store/session';
import type { SavedPlaceDoc, UserDoc } from '../../../shared/firestoreSchema';

/**
 * PROFILE: one source of truth.
 *
 *   local  useSession.person (persisted on the phone)  ← every screen reads this
 *   cloud  users/{uid} (displayName, nameEditedAt, phone, addresses, savedPlaces, photoData…)
 *   Google account name/photo: only the initial default, never overwrites what the person typed.
 *
 * core/sync/profileSync.ts moves changes both ways with last-writer-wins timestamps:
 *   name   → person.nameEditedAt   vs  cloud nameEditedAt
 *   other  → session.profileEditedAt vs cloud profileUpdatedAt
 *   photo  → photoCache.custom.updatedAt vs cloud photoUpdatedAt
 * The functions below are pure (tested in tests/profileSync.test.ts).
 */

export const MAX_NAME = 60;
export const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);

/** The person typed their name (Settings). Applies everywhere at once; profileSync uploads it. */
export function setProfileName(name: string) {
  const clean = cleanName(name);
  if (!clean) return false;
  const s = useSession.getState();
  if (clean === s.person.name && s.person.nameEditedAt) return true;
  useSession.setState({ person: { ...s.person, name: clean, nameEditedAt: Date.now() } });
  mirrorNameToAuth(clean);
  return true;
}

/**
 * Screens that still read the auth user's displayName (profile menu, avatar initials) see the same
 * name as Home. The Google name stays available as user.providerName.
 */
export function mirrorNameToAuth(name: string) {
  const u = useAuth.getState().user;
  if (u && name && u.displayName !== name) useAuth.setState({ user: { ...u, providerName: u.providerName ?? u.displayName, displayName: name } });
}

const isGuardianApp = () => (useAuth.getState().role ?? useSession.getState().entryRole) === 'guardian';

/** This account's own display name: what the person typed, else the Google name. */
export function profileName(): string {
  if (isGuardianApp()) return useAuth.getState().user?.displayName ?? '';
  return useSession.getState().person.name || useAuth.getState().user?.displayName || '';
}

/** React: this account's own display name (updates the moment it is edited). */
export function useProfileName(): string {
  const personName = useSession((s) => s.person.name);
  const role = useAuth((s) => s.role);
  const entryRole = useSession((s) => s.entryRole);
  const authName = useAuth((s) => s.user?.displayName ?? '');
  if ((role ?? entryRole) === 'guardian') return authName;
  return personName || authName;
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

// ─── pure merge logic ─────────────────────────────────────────

type CloudProfile = Partial<Pick<UserDoc, 'displayName' | 'nameEditedAt' | 'phone' | 'email' | 'homeAddress' | 'homePlace' | 'workAddress' | 'savedPlaces' | 'profileUpdatedAt' | 'photoData' | 'photoUpdatedAt'>>;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function validPlace(p: unknown): p is SavedPlaceDoc {
  const x = p as SavedPlaceDoc;
  return !!x && typeof x.id === 'string' && typeof x.lat === 'number' && typeof x.lng === 'number' && Math.abs(x.lat) <= 90 && Math.abs(x.lng) <= 180;
}

function placesFromCloud(c: CloudProfile): SavedPlace[] | null {
  if (Array.isArray(c.savedPlaces)) {
    return c.savedPlaces.filter(validPlace).map((p) => ({ id: p.id, label: str(p.label) || p.id, placeId: str(p.placeId), name: str(p.name), address: typeof p.address === 'string' ? p.address : null, lat: p.lat, lng: p.lng, updatedAt: num(p.updatedAt) }));
  }
  const h = c.homePlace;
  if (h && typeof h.lat === 'number' && typeof h.lng === 'number') {
    return [{ id: 'home', label: h.label || 'Home', placeId: h.placeId ?? '', name: (h.address ?? '').split(',')[0] || 'Home', address: h.address ?? null, lat: h.lat, lng: h.lng, updatedAt: 0 }];
  }
  return null;
}

export interface ProfileMerge {
  /** New local person, or null when nothing changes on the phone. */
  person: Person | null;
  /** New session.profileEditedAt (the cloud's time when its fields were taken). */
  profileEditedAt: number | null;
  /** The phone holds something newer than the cloud: upload it. */
  push: boolean;
}

/**
 * Cloud user doc → local person. Never loses a newer edit on either side; the Google name only fills
 * an empty name and never replaces one the person typed.
 */
export function mergeCloudProfile(local: { person: Person; profileEditedAt: number }, cloud: CloudProfile, googleName: string | null): ProfileMerge {
  const p = local.person;
  let next: Person = p;
  let push = false;
  let editedAt: number | null = null;

  // Name
  const cloudNameAt = num(cloud.nameEditedAt);
  const localNameAt = num(p.nameEditedAt);
  const cloudName = cleanName(str(cloud.displayName));
  if (cloudNameAt > localNameAt && cloudName) {
    next = { ...next, name: cloudName, nameEditedAt: cloudNameAt };
  } else if (localNameAt > cloudNameAt) {
    push = true;
  } else if (!localNameAt) {
    // Nobody typed a name yet: the account's name (Google default) fills it.
    const def = cloudName || cleanName(p.name) || cleanName(googleName ?? '');
    if (def && def !== p.name) next = { ...next, name: def };
  }

  if (!next.email && cloud.email) next = { ...next, email: cloud.email };

  // Phone, addresses, places
  const cloudAt = num(cloud.profileUpdatedAt);
  const localAt = num(local.profileEditedAt);
  if (cloudAt > localAt) {
    const places = placesFromCloud(cloud);
    next = {
      ...next,
      phone: str(cloud.phone),
      homeAddress: str(cloud.homeAddress),
      workAddress: str(cloud.workAddress),
      savedPlaces: places ?? next.savedPlaces,
    };
    editedAt = cloudAt;
  } else if (localAt > cloudAt) {
    push = true;
  } else if (!cloudAt && !localAt) {
    // Older account data (no timestamps yet): fill what this phone does not have, overwrite nothing.
    const places = placesFromCloud(cloud);
    next = {
      ...next,
      phone: next.phone || str(cloud.phone),
      homeAddress: next.homeAddress || str(cloud.homeAddress),
      workAddress: next.workAddress || str(cloud.workAddress),
      savedPlaces: next.savedPlaces.length ? next.savedPlaces : (places ?? []),
    };
  }

  const changed = JSON.stringify(next) !== JSON.stringify(p);
  return { person: changed ? next : null, profileEditedAt: editedAt, push };
}

/** Local person → the fields written to users/{uid} (merge). */
export function profileCloudPatch(person: Person, profileEditedAt: number): Record<string, unknown> {
  const home = person.savedPlaces.find((x) => x.id === 'home');
  const out: Record<string, unknown> = {};
  if (person.nameEditedAt && cleanName(person.name)) {
    out.displayName = cleanName(person.name);
    out.nameEditedAt = person.nameEditedAt;
  }
  if (profileEditedAt) {
    out.phone = person.phone.trim() || null;
    out.homeAddress = person.homeAddress.trim() || null;
    out.workAddress = person.workAddress.trim() || null;
    out.savedPlaces = person.savedPlaces.slice(0, 20).map((x) => ({ id: x.id, label: x.label, placeId: x.placeId ?? '', name: x.name, address: x.address ?? null, lat: x.lat, lng: x.lng, updatedAt: x.updatedAt ?? 0 }));
    // "Take me home" and the geofence use homePlace on the server: keep it equal to the saved Home.
    if (home) out.homePlace = { lat: home.lat, lng: home.lng, placeId: home.placeId || null, address: home.address ?? home.name, label: home.label || 'Home' };
    else if (!person.homeAddress.trim()) out.homePlace = null;
    out.profileUpdatedAt = profileEditedAt;
  }
  return out;
}

export interface PhotoMerge {
  /** Apply the cloud photo locally (dataUrl may be null = removed there). */
  apply: { dataUrl: string | null; updatedAt: number } | null;
  push: boolean;
}

/** Cloud photo ↔ local picked photo, last writer wins. */
export function mergeCloudPhoto(local: { dataUrl: string | null; updatedAt: number } | null, cloud: CloudProfile): PhotoMerge {
  const cloudAt = num(cloud.photoUpdatedAt);
  const localAt = local?.updatedAt ?? 0;
  if (cloudAt > localAt) {
    const d = typeof cloud.photoData === 'string' && cloud.photoData.startsWith('data:image/') ? cloud.photoData : null;
    return { apply: { dataUrl: d, updatedAt: cloudAt }, push: false };
  }
  return { apply: null, push: localAt > cloudAt };
}
