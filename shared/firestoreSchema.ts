/**
 * Firestore document shapes and path helpers. FIREBASE_SCHEMA.md explains the
 * reasoning; firestore.rules enforces who may read and write each path.
 * Timestamps are epoch milliseconds (number) unless named *At with serverTimestamp noted.
 */
export const paths = {
  user: (uid: string) => `users/${uid}`,
  settings: (uid: string, doc: 'app' | 'safety' | 'guardian') => `users/${uid}/settings/${doc}`,
  contacts: (uid: string) => `users/${uid}/contacts`,
  devices: (uid: string) => `users/${uid}/devices`,
  live: (uid: string, doc: 'device' | 'location' | 'safety' | 'navigation') => `users/${uid}/live/${doc}`,
  activity: (uid: string) => `users/${uid}/activity`,
  sos: (uid: string) => `users/${uid}/sosEvents`,
  notifications: (uid: string) => `users/${uid}/notifications`,
  conversations: (uid: string) => `users/${uid}/aiConversations`,
  messages: (uid: string, cid: string) => `users/${uid}/aiConversations/${cid}/messages`,
  walkSessions: (uid: string) => `users/${uid}/walkSessions`,
  navigationSessions: (uid: string) => `users/${uid}/navigationSessions`,
  fcmTokens: (uid: string) => `users/${uid}/fcmTokens`,
  relationship: (userUid: string, guardianUid: string) => `relationships/${userUid}_${guardianUid}`,
  cameraSessions: () => `cameraSessions`,
  deviceRegistry: (deviceId: string) => `devices/${deviceId}`,
};

export const relationshipId = (userUid: string, guardianUid: string) => `${userUid}_${guardianUid}`;

export type AccountRole = 'user' | 'guardian';

export interface UserDoc {
  uid: string;
  role: AccountRole;
  displayName: string;
  photoURL: string | null;
  email: string | null;
  phone: string | null;
  /** Stick user's home address (for 'take me home' and the guardian geofence). */
  homeAddress?: string | null;
  /** The exact place the user picked on the map during setup (preferred over geocoding homeAddress). */
  homePlace?: { lat: number; lng: number; placeId: string | null; address: string; label: string } | null;
  /** For a stick user: the active guardian relationship (1 user → 1 guardian). */
  guardianRelationshipId: string | null;
  /** For a guardian: the user they look after. */
  watchesUserUid: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GuardianPermissions {
  location: boolean;
  camera: boolean;
  activity: boolean;
  sos: boolean;
  messages: boolean;
  safetySettings: boolean;
}

export interface RelationshipDoc {
  relationshipId: string;
  userUid: string;
  guardianUid: string;
  status: 'active' | 'revoked';
  role: 'guardian';
  permissions: GuardianPermissions;
  /** How the stick user hears the guardian ("Mom"). */
  heardAs: string;
  guardianName: string;
  userName: string;
  guardianPhone: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export type Quality = 'good' | 'fair' | 'poor' | 'unknown';

export interface LiveDeviceDoc {
  deviceId: string | null;
  link: 'unpaired' | 'connected' | 'degraded' | 'connecting' | 'reconnecting' | 'disconnected' | 'auth_failed' | 'protocol_mismatch';
  /** ECU obstacle zone at the last write (decided on the stick). */
  zone?: string;
  /** Device-reported health summary (no raw telemetry). */
  health?: { resetReason: string | null; errors: string[]; mode: string | null; configVersion: number | null } | null;
  battery: { percent: number | null; charging: boolean | null; chargingSource: 'hardware' | 'inferred' | null; status: string; measuredAt: number | null };
  /** obstacleCm: last filtered forward distance rounded to 10 cm (null unless status ok). */
  sensors: { ultrasonic: string; imu: string; camera: string; obstacleCm?: number | null };
  firmware: string | null;
  phoneInternet: boolean;
  updatedAt: number;
  source: 'user-app';
}

export interface LiveLocationDoc {
  lat: number;
  lng: number;
  accuracyM: number;
  headingDeg: number | null;
  speedMps: number | null;
  measuredAt: number;
  updatedAt: number;
  quality: Quality;
  source: 'gps' | 'network' | 'fused';
}

export type SafetyStateName = 'unknown' | 'initializing' | 'healthy' | 'warning' | 'critical' | 'sos' | 'connectionLost' | 'stale';

export interface LiveSafetyDoc {
  state: SafetyStateName;
  reasons: string[];
  updatedAt: number;
}

export interface LiveNavigationDoc {
  active: boolean;
  destination: { name: string; placeId: string | null; lat: number; lng: number } | null;
  remainingM: number | null;
  etaSec: number | null;
  nextInstruction: string | null;
  arrived: boolean;
  updatedAt: number;
}

export interface ActivityDoc {
  eventId: string;
  kind: 'safety' | 'navigation' | 'device' | 'vision' | 'message';
  severity: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  detail: string | null;
  ts: number;
  source: 'user-app' | 'device' | 'guardian' | 'backend';
  deviceId: string | null;
}

export interface SosDoc {
  sosId: string;
  trigger: 'button' | 'voice' | 'fall';
  state: 'active' | 'acknowledged' | 'resolved';
  createdAt: number;
  location: { lat: number; lng: number; accuracyM: number; measuredAt: number } | null;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
  onTheWayAt: number | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
  smsFallback: 'not_needed' | 'sent' | 'composer_opened' | 'failed' | 'unavailable';
}

export interface NotificationDoc {
  type: 'guardian_message' | 'system';
  text: string;
  fromUid: string;
  createdAt: number;
  spokenAt: number | null;
}

export interface CameraSessionDoc {
  userUid: string;
  guardianUid: string;
  mode: 'snapshot' | 'live';
  state: 'requested' | 'accepted' | 'connecting' | 'live' | 'ended' | 'denied' | 'failed';
  reason: string | null;
  offer: { type: 'offer'; sdp: string } | null;
  answer: { type: 'answer'; sdp: string } | null;
  createdAt: number;
  updatedAt: number;
  /** Firestore Timestamp; a TTL policy on this field deletes the session (and it is never used for media). */
  expireAt: unknown;
}

export interface WalkSessionDoc {
  startTime: number;
  endTime: number | null;
  distanceM: number;
  durationS: number;
  meanAccuracyM: number | null;
  source: 'gps';
  rejectedFixes: number;
}
