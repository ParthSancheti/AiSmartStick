# Firebase architecture & schema — AI Smart Stick

Types: `shared/firestoreSchema.ts`. Enforcement: `firestore.rules`, `storage.rules`. Region: `asia-south1`.

## Identity and authorization model
* **Identity** = Firebase Auth UID (Google sign-in). The client never supplies a uid that the server trusts.
* **1 user → 1 guardian.** `relationships/{userUid}_{guardianUid}` is created only by the
  `claimPairingCode` Cloud Function. Clients can read a relationship they belong to, but can never
  write one.
* Every guardian read resolves `relationships/{pathUid}_{request.auth.uid}` in the rules: it must exist,
  be `active`, and carry the needed permission (`location`, `camera`, `activity`, `sos`, `messages`,
  `safetySettings`). Guessing a UID gives nothing.
* Revoking (`revokeRelationship`, either side) sets `status: revoked` and removes all guardian access immediately.

## Collections
| Path | Writer | Reader | Content |
|---|---|---|---|
| `users/{uid}` | owner (role/pointers are server-managed) | owner, guardian | `UserDoc`: role `user\|guardian`, displayName, photoURL, phone, homeAddress, `guardianRelationshipId`, `watchesUserUid`, `homeLocation` (server cache) |
| `users/{uid}/settings/app` | owner; guardian **only** SOS keys with `safetySettings` | owner, guardian | Synced settings: voice, language, volume, haptics, SOS options, location sharing, camera requests, call/SMS mode, guardian notify prefs, geofence. Theme, text size, contrast and IMU calibration stay on the phone |
| `users/{uid}/contacts/{id}` | owner (write-through from the Settings contact list; restored on a new phone) | owner, guardian(sos) | Emergency contacts |
| `users/{uid}/devices/{deviceId}` | owner | owner, guardian | Paired stick metadata: model, firmware, protocolVersion, pairedAt, authState. **Never the key** (rules reject it) |
| `users/{uid}/live/device` | user phone | owner, guardian | `LiveDeviceDoc`: link (incl. degraded/protocol_mismatch), ECU zone, health {resetReason, errors, mode, configVersion}, battery {percent, charging, chargingSource, status, measuredAt}, sensor statuses, obstacleCm (10 cm), firmware, phoneInternet, updatedAt |
| `users/{uid}/live/location` | user phone | owner, guardian(location) | lat/lng, accuracyM, heading, speed, measuredAt, quality |
| `users/{uid}/live/safety` | user phone | owner, guardian | `unknown\|initializing\|healthy\|warning\|critical\|sos\|connectionLost\|stale` + reasons |
| `users/{uid}/live/navigation` | user phone | owner, guardian | destination, remainingM, etaSec, nextInstruction, arrived |
| `users/{uid}/activity/{eventId}` | user phone (append-only, id = event id → idempotent) | owner, guardian(activity) | kind, severity, title, detail, ts, source, deviceId |
| `users/{uid}/walkSessions/{id}` | user phone (append-only) | owner, guardian(activity) | start/end, distanceM, durationS, meanAccuracyM, rejectedFixes, source `gps` |
| `users/{uid}/sosEvents/{sosId}` | user creates; user may resolve; guardian may acknowledge / on-the-way / resolve (field allow-list) | owner, guardian(sos) | trigger, state, location snapshot, ack/onTheWay/resolved timestamps and actors, smsFallback |
| `users/{uid}/deviceCommands/{id}` | **`sendRemoteCommand` only** creates; user phone updates status/result/error | owner, guardian | Guardian remote command: type locate/nudge/scan, issuedBy, createdAt, expiresAt (+2 min), status queued→received→executing→completed/failed/expired, result (text only) |
| `users/{uid}/medical/profile` | owner | owner, guardian(sos) | bloodGroup, allergies, medications, conditions, notes, updatedAt. Never logged / never sent to Gemini |
| `users/{uid}/notifications/{id}` | guardian creates `guardian_message`; owner marks `spokenAt` | owner; guardian its own | Guardian → user voice messages |
| `users/{uid}/aiConversations/{cid}` (+ `/messages/{mid}`) | **Cloud Functions only** | owner | title, updatedAt, pendingJson (in-progress Gemini turn incl. thought signatures); messages: role, text, ts, language, toolCalls, toolResults |
| `users/{uid}/fcmTokens/{token}` | owner | owner | platform, role, updatedAt |
| `users/{uid}/private/*` | server only | nobody | quotas, geofence state, notification de-dup, vision stats |
| `relationships/{userUid_guardianUid}` | Cloud Functions only | the two members | `RelationshipDoc`: status, role, permissions, heardAs, names, guardianPhone, createdAt, revokedAt |
| `pairingSessions/{code}` | Cloud Functions only | nobody | guardianUid, labels, expiresAt (10 min), claimed; TTL field `expireAt` |
| `devices/{deviceId}` | owner (first owner wins; must unpair to release) | owner | ownerUid + metadata (registry) |
| `cameraSessions/{sid}` (+ `guardianCandidates`, `userCandidates`) | guardian creates (needs `camera`), both update state/answer | the two members | WebRTC offer/answer/ICE, state, mode, timestamps, `expireAt` (**Timestamp**, TTL). **No media, ever** |

## Write rates (no raw telemetry in Firestore)
| Data | Phone samples | Firestore |
|---|---|---|
| Telemetry | 300 ms from the stick | never raw |
| `live/device` | on change | link changes immediately; other changes max 1 per 10 s (trailing write); heartbeat 60 s |
| `live/location` | GPS stream | moved ≥ 20 m or 30 s (10 s during SOS); only if location sharing is on or an SOS is active |
| `live/safety`, `live/navigation` | on change | on change / every 30 s while navigating |
| activity, walks, SOS | events | one document each |

Offline: Firestore persistent cache queues writes. SOS reports "delivered" only after the server
acknowledges (`hasPendingWrites === false`), otherwise it falls back to SMS.

## Required console setup
* **TTL policies** (Console → Firestore → TTL, or):
  `gcloud firestore fields ttls update expireAt --collection-group=cameraSessions --enable-ttl`
  `gcloud firestore fields ttls update expireAt --collection-group=pairingSessions --enable-ttl`
* Deploy rules and indexes: `firebase deploy --only firestore,storage`.
* Storage stays closed (`storage.rules` denies everything). Camera media is never uploaded.

## Cloud Functions (callable = Auth + App Check enforced)
| Name | Purpose |
|---|---|
| `assistantTurn` | Gemini turn: history + tools → actions or reply; persists messages; quota 30/min, 1500/day |
| `assistantVision` | JPEG → structured `VisionResult` (JSON schema), unsafe-claim filter; image not stored |
| `mapsSearch` / `mapsPlace` / `mapsRoute` / `mapsReverse` / `mapsAutocomplete` | Places API (New) search, details and autocomplete (session tokens), Routes API (WALK), Geocoding, with field masks |
| `createPairingCode` / `claimPairingCode` / `revokeRelationship` / `updateRelationship` | Relationship lifecycle (code brute-force limit 5/h); pairing and unlink push to the other side |
| `deleteAccount` | Revokes relationships, releases stick registrations, recursively deletes `users/{uid}`, deletes the Auth user |
| `onSosCreated`, `onSosUpdated` | FCM high-priority push to the guardian (`sos` channel), de-duplicated per SOS id; writes `guardianNotify {status: sent/failed/no_devices/no_guardian}` so the user app only says "notified" when FCM accepted it |
| `sendRemoteCommand` | Guardian → user phone command relay (locate / nudge / scan); relationship + permission + 6/min rate limit; no remote SOS |
| `onLiveDevice` | Push on stick disconnect / critical battery (≤ 10 %), respecting guardian prefs |
| `onLiveLocation` | Geofence `{enabled, radiusM, name, center|null=home}` from the guardian's settings; debounced by `geofenceStep` (2 outside readings ≥ 30 s, re-arm clearly inside); exit & enter pushes |
| `staleLocationSweep` | Every 10 min: push once per episode if location > 30 min old |
| `onCameraSessionCreated` | Validates the guardian permission server-side; wakes the user's phone |

## Pairing QR
The Guardian's screen shows a QR code containing `aiss://pair?v=1&code=NNNNNN`. The user's app scans it
with the Google code scanner, or the code is typed. The code is only a claim ticket: it is redeemed by
`claimPairingCode`, is single-use, and expires after 10 minutes.

## Rules tests
`tests/rules/firestore.rules.test.ts` covers:
* guardian access by relationship and permission; guessing a uid is denied
* revocation takes effect immediately
* clients cannot write relationships
* SOS field allow-list and acknowledging as yourself only
* role and relationship pointers are immutable
* functions-only AI history
* device keys are never stored
* the guardian may change only SOS settings
* camera-session create permission and TTL

Run with `npm run test:rules` (Firestore emulator; needs Java and firebase-tools).
