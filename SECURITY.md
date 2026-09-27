# Security

| Area | Control | Verified here |
|---|---|---|
| Secrets | Gemini and Maps server keys are in Secret Manager only. There is no Admin credential in the client. The client holds only public Firebase config and a restricted Maps browser key | grep: no secrets in `src/` |
| Auth | Firebase Auth (Google). Every callable uses `requireAuth` + `enforceAppCheck` | typecheck |
| Authorization | `firestore.rules`: owner-only paths; guardian access via `relationships/{user_guardian}` status and permission flags; server-only relationships, pairing, AI history and private state; field allow-lists (SOS acknowledge as yourself, command status only, SOS-settings-only guardian writes); device keys forbidden | 14 emulator tests written (`npm run test:rules`), **not run** (emulator blocked here) |
| Client trust | Role, relationship pointers and permissions are never client-writable. SOS state changes are field-restricted. Guardian commands exist only via `sendRemoteCommand` (whitelist, permission, rate limit, expiry) | rules tests |
| Pairing | 6-digit one-time code, 10-minute expiry, 5 wrong tries per hour, transaction; the QR holds only that code | — |
| Device | HMAC-SHA256 on every request, nonce ring (32), timestamp window, challenge proof, signed discovery, setup-code WPA2 AP; the key is only in Keystore / NVS | `tests/transport-e2e.test.ts` (wrong key → auth_failed; replay refused) |
| Commands | Envelope with id and expiry; idempotent; whitelisted; bounded payload (1 KB); safety patterns cannot be pre-empted | e2e + host tests |
| Telemetry | Strict validation; 16 KB cap; poisoned packets dropped | `integration-contracts.test.ts` |
| Medical data | `users/{uid}/medical/profile`: owner writes, linked guardian (`sos` permission) reads. Never logged or sent to Gemini | rules test written |
| Logs | Categories debug, info, warn, error, security, safety. Keys matching token, key, password, secret, sig, auth or medical are redacted; no images or audio | unit test |
| Debug endpoints | The firmware has none (self-test is an authenticated command). The legacy prototype is reachable only from Settings → Hardware test and is labelled. Demo code runs only when `mode === 'demo'` | code review |
| OTA | Not implemented. Design: signed manifest, authenticated upload, rollback (FIRMWARE_SETUP.md) | — |
| Known gaps | Cleartext HTTP on the local hotspot (payload is authenticated but **not encrypted**, so telemetry is readable by other hotspot clients). TURN not configured. Play policy declarations for SMS, calls and the foreground service are pending | — |
