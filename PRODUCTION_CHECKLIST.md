# Production checklist, feature traceability and classification

**SOFTWARE-COMPLETE ≠ HARDWARE-VALIDATED.** Nothing here has run on the physical stick, a real Android
build, or live Firebase/Gemini/Maps. The system is **not production-ready** until every 🔧 row passes.

**Classification key**
* **RC** = real and connected (verified in this environment by tests, build or headless UI)
* **NC** = real, needs credentials or environment configuration
* **HW** = real, needs a physical hardware test
* **P** = partial
* **D** = demo only
* **NI** = not implemented

## Feature traceability matrix
| Feature | UI | Android | Backend | Firebase | Gemini | ECU | Class | Real-tested |
|---|---|---|---|---|---|---|---|---|
| Google sign-in / session / sign-out / delete | ✓ | ✓ native credential | ✓ deleteAccount | Auth | — | — | NC | ✗ |
| User ↔ Guardian pairing (QR + code, 1:1) | ✓ | ✓ ML Kit scanner | ✓ callables | ✓ rules | — | — | NC | ✗ |
| Device provisioning (setup AP) | ✓ | ✓ WifiNetworkSpecifier | — | metadata | — | ✓ | HW | ✗ |
| Device identity (HMAC, proof, replay) | ✓ | ✓ Keystore | — | key never stored | — | ✓ | RC (e2e vs protocol server) + HW | ✗ |
| Protocol version check / mismatch state | ✓ | — | — | — | — | ✓ | RC | ✗ |
| Reconnect (backoff, degraded, stale) | ✓ | — | — | — | — | ✓ STA backoff | RC + HW | ✗ |
| Ultrasonic → zone FSM → motor (local) | ✓ mirror | — | — | zone | — | ✓ | RC (host tests) + HW | ✗ |
| Obstacle P0 speech | ✓ | TTS | — | — | — | zone | RC | ✗ |
| Fall detection | settings | — | — | — | — | ✓ | RC (host tests) + HW | ✗ |
| Battery (raw INA219 → one estimator) | ✓ | — | — | ✓ throttled | read-only tool | ✓ | RC + HW | ✗ |
| Runtime estimate | ✓ | — | — | — | — | — | RC (only from measured discharge, else hidden) | ✗ |
| IMU → StickVisual | ✓ | — | — | — | — | ✓ | RC (demo) + HW | ✗ |
| Button gestures / SOS hold feedback | ✓ | — | — | — | — | ✓ | RC + HW | ✗ |
| Camera capture | ✓ | — | — | — | ✓ | ✓ | HW | ✗ |
| AI vision + sensor fusion | ✓ | — | ✓ assistantVision | — | ✓ | ✓ | NC + HW | ✗ |
| Gemini assistant (tools, confirmation, history) | ✓ | STT/TTS | ✓ assistantTurn | ✓ history | ✓ | — | NC | ✗ |
| Gemini Live | — | — | — | — | — | — | **NI** (by design, AUDIO_ARCHITECTURE.md) | — |
| On-device object detection | — | — | — | — | — | — | **NI** (needs benchmark) | — |
| Unified audio P0–P6 | ✓ orb | native TTS | — | — | ✓ | — | RC | ✗ |
| Places / autocomplete / routes / navigation | ✓ | GPS | ✓ maps* | — | ✓ tools | — | NC | ✗ |
| Walking distance (pause/resume) | ✓ | GPS | — | ✓ sessions | — | — | RC (logic) + NC | ✗ |
| SOS lifecycle (TRIGGERED…RESOLVED/FAILED) | ✓ | ✓ call/SMS | ✓ push + guardianNotify | ✓ | voice trigger | hold, fall | RC (logic) + NC | ✗ |
| Guardian dashboard / map / activity | ✓ | — | — | ✓ feed | — | — | NC | ✗ |
| Geofence (centre, radius, name, debounce) | ✓ | — | ✓ onLiveLocation | ✓ | — | — | RC (debounce tests) + NC | ✗ |
| Guardian remote: Find / Nudge / Scan | ✓ | — | ✓ sendRemoteCommand | ✓ deviceCommands | scan | ✓ | RC (demo UI, rules written) + NC + HW | ✗ |
| Guardian remote SOS | — | — | — | — | — | — | **Not allowed** (policy) | — |
| Guardian camera session | ✓ states | WebRTC | ✓ | ✓ signalling | — | ✓ | NC + HW | ✗ |
| Device config (sensitivity/strength/sleep, versioned + ack) | ✓ | — | — | ✓ settings | — | ✓ | RC (demo, e2e mock) + HW | ✗ |
| Self-test / diagnostics | ✓ | — | — | — | — | ✓ | HW | ✗ |
| Medical profile | ✓ | — | — | ✓ rules | never | — | NC | ✗ |
| Contact picker | ✓ | ✓ ACTION_PICK | — | ✓ contacts | — | — | NC (device) | ✗ |
| Calls / SMS (truthful results) | ✓ | ✓ | — | — | ✓ confirm | — | NC (device, Play policy) | ✗ |
| Foreground service / battery optimisation | ✓ | ✓ | — | — | — | — | NC (device) | ✗ |
| Pocket mode | ✓ | keep-screen-on | — | — | — | — | NC (device) | ✗ |
| Notifications (FCM, dedupe) | ✓ | ✓ channels | ✓ | ✓ tokens | — | — | NC | ✗ |
| Watchdog / reset reason / safe mode | ✓ shown | — | — | health | — | ✓ | HW | ✗ |
| OTA | — | — | — | — | — | — | **NI** (design only) | — |
| Demo mode (sim, mockBrain, MockMap, MockTransport) | ✓ | — | — | — | — | — | D (isolated by `mode === 'demo'`) | ✓ headless |

## Release gates
1. **Hardware:** HARDWARE_WIRING.md §5 bench checks, then FIRMWARE_SETUP.md tests 1–14, all passing and recorded.
2. **Android:** `./gradlew assembleRelease` on CI; device run of the INTEGRATION_STATUS.md QA list on at
   least a Pixel, a Samsung and a Xiaomi.
3. **Backend:**
   * rules tests pass (`npm run test:rules`);
   * functions deployed with secrets;
   * App Check enforced;
   * TTL policies on;
   * Maps keys restricted.
4. **Policy:** Play declarations for the foreground service (connectedDevice, location), and optionally
   SMS/CALL; privacy policy covering location, camera and medical data.
5. **Field:** supervised walks with orientation-and-mobility professionals before any unsupervised use.
