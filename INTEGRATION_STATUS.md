# AI Smart Stick: integration status

**Summary:** the software is complete for this phase. Physical hardware has not been validated.

## 1. State of the system
* One protocol contract: DEVICE_PROTOCOL.md.
* The ECU firmware implements that contract: modular HAL, P0–P4 loop, ECU-local obstacle safety with
  hysteresis and confirmation, fall detection, versioned configuration with acknowledgement,
  idempotent commands, health reporting, safe mode and watchdog.
* The app consumes the same contract.
* Guardian commands are relayed through the backend.
* All speech goes through one orchestrator with priorities P0–P6.

Full classification and the traceability matrix: **PRODUCTION_CHECKLIST.md**.

## 2. Verification actually executed here
| Check | Result |
|---|---|
| `npm run typecheck` (strict TS; no ESLint is configured in this repo) | 0 errors |
| `npm test` (vitest) | **81/81 passed**, 12 files, including `transport-e2e` (app HttpTransport against a protocol-conformant local server: key proof, telemetry, idempotent commands, wrong key → auth_failed, protocol mismatch, replay refused) and `integration-contracts` (geofence debounce, SOS lifecycle, config presets satisfy the ECU validator, mock idempotency, fusion, 9 poisoned-packet cases, error and log redaction, orb mapping) |
| `npm run test:firmware` (g++, SafetyLogic.h) | **25/25 passed**: zones, no chatter under ±5 cm noise, spike rejection, stale → unknown, disabled, fall pattern vs tap vs noise, command-id ring |
| Firmware compile (`esp32:esp32:esp32cam`, core 2.0.9) | Passes, **0 warnings**, 891,885 B flash (28 %), 56,900 B RAM (17 %) |
| `npm run build` / `functions` build | Pass; functions: 19 exports load |
| `npm run android:typecheck` | Native Java compiles against android.jar API 30 (with stubs) |
| `npx cap sync android` | Passes, 13 plugins |
| Headless Chromium | No page errors. Covered: demo user and Guardian screens; provisioning; map search → route → end; SOS; hardware settings → "✓ Applied on the stick (vN)" after ack; self-test report; Guardian "Find the stick" → "The stick is vibrating"; real mode without config stops honestly at sign-in |
| **Not executable here** | Gradle APK (Google Maven blocked), Firestore emulator (blocked; 14 rules tests written and typechecked), live Firebase/Gemini/Maps (no credentials), any hardware |

## 3. External and hardware dependencies
* **Credentials and configuration:** see ANDROID_SETUP.md and FIREBASE_SCHEMA.md.
* **Wiring conditions:** see HARDWARE_WIRING.md (echo divider, motor MOSFET, GPIO3 button caveats,
  power and brownout).
* **Hardware procedure:** FIRMWARE_SETUP.md, tests 1–14.

## 4. Software QA list for the first device run
1. Fresh install → Google sign-in → kill the app → reopen (session restored) → sign out (nothing from
   the account remains) → sign in again.
2. Guardian PWA: sign in → QR shown → user scans → both show linked → Guardian gets a "linked" push.
3. Guardian: Unlink → the user gets a push → the Guardian loses access immediately.
4. Assistant: "What's my battery?" (states estimate and freshness), "Find the nearest salon" → "Take me
   there" (route on the map, spoken), "Text my guardian I reached home" (asks for confirmation; says
   "composer opened" unless direct SMS is approved), "Call my guardian".
5. Map: search with autocomplete → route → walk off route (reroute) → arrive → End route.
6. Health: Start walk → Pause (walk 50 m, not counted) → Resume → End (a session appears in the
   Guardian's activity).
7. SOS: hold 3 s → cancel within 5 s; again → let it send → Guardian push + takeover → acknowledge
   (the user hears it) → on my way → resolve. Repeat in airplane mode (SMS path).
8. Guardian → Request photo → the user hears "asked to see your camera" → the photo arrives → "Camera
   ended". Try "Ask me first".
9. Screen off for 10 minutes with the stick paired → notification present, stick still connected, the
   Guardian sees updates.
10. Settings → Delete account (both apps).

## 5. Settings destination map
| Setting | Destination |
|---|---|
| Theme, glass, reduce motion, text size, high contrast, screen reader, IMU calibration, keep running in background, pocket keep-alive | LOCAL (phone) |
| Voice on/off, reply language, voice speed, volume, haptics, earcons | FIREBASE (`settings/app`), applied by the audio manager and haptics |
| SOS triggers, countdown, message, low-battery threshold | FIREBASE; Guardian may edit with `safetySettings` |
| Location sharing, camera requests (announce & allow / ask), call mode, SMS mode | FIREBASE + ANDROID (permissions requested on opt-in) |
| Guardian notification prefs, geofence | FIREBASE (read by the Cloud Functions) |
| Contacts | FIREBASE (`contacts`) |
| Profile (name, phone, home address) | FIREBASE (`users/{uid}`) |
| Obstacle sensitivity, vibration strength, obstacle vibration, auto sleep, fall detection | DEVICE (versioned `setConfig`, shown as applied only after the ECU ack) + FIREBASE |
| Hardware: locate, self-test, calibrate, unpair, set up again, hardware test | DEVICE (signed, idempotent commands) / LOCAL key store |
| Medical profile | FIREBASE (`medical/profile`, guardian-readable for emergencies) |
| Assistant settings by voice | AI → validated `change_setting` (voice rate, language, volume, earcons, haptics, text size, contrast); SOS and privacy settings are refused by design |
| Mode (real / demo) | LOCAL; restarts the app |


## 6. Known limitations
1. The local stick link is authenticated but not encrypted (cleartext HTTP on the WPA2 hotspot).
2. Gemini Live and on-device object detection are not implemented (see the reasons in AI_ARCHITECTURE.md).
3. OTA is designed but not implemented.
4. OEM battery managers can still stop background operation. The UI points users to the exemption.
5. Direct SMS and calls need Play declarations; without them the composer or dialer opens and the app
   says so.
6. The Guardian location card shows accuracy and freshness, not a street name.
7. There is no step, heart-rate or calorie source, so those show as Unavailable.
8. The web bundle is about 1.5 MB (no code splitting).
