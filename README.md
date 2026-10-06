# AI Smart Stick

A smart white cane (ESP32-CAM + sensors) with an Android app for the person who uses it and a Guardian
app for family. The app is built with React, TypeScript and Capacitor, and uses Firebase with Gemini
(through Cloud Functions) and Google Maps.

| Part | Where | Ships as |
|---|---|---|
| Stick user app | `src/features/user` | Android (Capacitor): `npm run android:sync` |
| Guardian app | `src/features/guardian` | PWA on Firebase Hosting: `npm run build:guardian` |
| Backend | `functions/` | Cloud Functions (Gemini, Maps, pairing, push) |
| Rules | `firestore.rules`, `storage.rules` | `firebase deploy --only firestore,storage` |
| ECU firmware | `firmware/ai_smart_stick_v1` | Arduino-ESP32, protocol v1 (compile + host-tested, **not hardware-tested**) |
| Contracts | `shared/` | Types shared by app + functions |

## Modes
* **Real** (production default): Google sign-in, the paired stick, GPS, Google Maps and Gemini. Missing
  data shows as missing ("Unavailable", "Waiting for device", "Updated 2 min ago"). Nothing falls back
  to demo data.
* **Demo** (`npm run dev`, or Settings → Device information → Demo mode): simulated stick, street and
  assistant, clearly badged **DEMO**, with its own separate local storage. On wide screens it shows both
  phones and the demo control panel.

## Commands
```bash
npm install
npm run dev              # demo mode dev server
npm run typecheck        # tsc
npm test                 # vitest: 81 tests incl. transport ↔ protocol e2e
npm run test:firmware    # g++ host tests of the ECU safety logic
npm run test:rules       # Firestore emulator (needs Java)
npm run build            # typecheck + production build (real mode)
npm run build:demo       # demo build → dist-demo/
npm run functions:build  # Cloud Functions
```

## Docs
* [INTEGRATION_STATUS.md](INTEGRATION_STATUS.md): what is real, what is demo-only, known issues, test results
* [DEVICE_PROTOCOL.md](DEVICE_PROTOCOL.md): stick ↔ phone protocol v1 (provisioning, HMAC auth, telemetry)
* [FIREBASE_SCHEMA.md](FIREBASE_SCHEMA.md): data model, security model, write rates, functions
* [ANDROID_SETUP.md](ANDROID_SETUP.md): Firebase / Maps / Gemini / FCM setup, permissions, build
* [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md): feature traceability matrix, classification, release gates
* [HARDWARE_WIRING.md](HARDWARE_WIRING.md): the owner's pin map audited, electrical conditions, power
* [FIRMWARE_SETUP.md](FIRMWARE_SETUP.md): ECU modules, build/flash, hardware test procedure, OTA design
* [PAIRING_FLOW.md](PAIRING_FLOW.md) · [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) · [AUDIO_ARCHITECTURE.md](AUDIO_ARCHITECTURE.md) · [CAMERA_PRIVACY.md](CAMERA_PRIVACY.md) · [SECURITY.md](SECURITY.md)

## Brand and design
* Product name: `src/core/brand/brand.ts`. Logo: **one file**, `src/core/brand/logo.svg` (also the favicon).
* Colours: semantic tokens in `src/styles.css` (brand/teal, success/ok, warning/amber, emergency/sos,
  info, muted). Components never use raw palette colours.
