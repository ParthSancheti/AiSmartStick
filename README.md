# Start here

Get the refined branch and set up the demo, Firebase, Android and ESP32 using [the complete setup guide](docs/SETUP.md). Matching existing Android adapters are included; [publication notes](GITHUB_PUBLICATION_NOTES.md) describe source provenance and checks.

Refinement package: see [battery and system report](BATTERY_EFFICIENCY_REFINEMENT_REPORT.md) and [walking guidance behavior](WALKING_GUIDANCE_REFINEMENT_REPORT.md). The confirmed single HC-SR04/camera cannot establish 150 m ranging or exact safe side clearance; device validation remains required.

# AI Smart Stick

A smart white cane (ESP32-CAM + sensors) with an Android app for the person who uses it and a Guardian
app for family. The app is built with React, TypeScript and Capacitor, and uses Firebase with Gemini
(through Cloud Functions) and Google Maps.

| Part | Where | Ships as |
|---|---|---|
| Stick user app | `src/features/user` | Android (Capacitor): `npm run android:sync` |
| Guardian app | `src/features/guardian` | PWA on Firebase Hosting: `npm run build`, then choose Guardian |
| Backend | `functions/` | Cloud Functions (Gemini, Maps, pairing, push) |
| Rules | `firestore.rules`, `storage.rules` | `firebase deploy --only firestore,storage` |
| ECU firmware | `firmware/ai_smart_stick_v1` | Arduino-ESP32, protocol v1 (compile + host-tested, **not hardware-tested**) |
| Contracts | `shared/` | Types shared by app + functions |

## Modes
* **Real** (production default): Google sign-in, the paired stick, GPS, Google Maps and Gemini. Missing
  data shows as missing ("Unavailable", "Waiting for device", "Updated 2 min ago"). Nothing falls back
  to demo data.
* **Demo** (`npm run dev:demo`, or Settings → Device information → Demo mode): simulated stick, street and
  assistant, clearly badged **DEMO**, with its own separate local storage. On wide screens it shows both
  phones and the demo control panel.

## Commands
```bash
npm ci
npm --prefix functions ci
npm run dev:demo         # explicit demo mode (Bash; PowerShell steps in docs/SETUP.md)
npm run typecheck        # tsc
npm test                 # vitest: 673 app tests incl. transport ↔ protocol e2e
npm run test:firmware    # g++ host tests of the ECU safety logic
npm run test:rules       # Firestore emulator (needs Java)
npm run build            # typecheck + production build (real mode)
npm run build:demo       # demo build → dist-demo/
npm run functions:build  # Cloud Functions
```

### Release: redeploy the Cloud Functions with every APK that changes `shared/tools.ts` or `functions/`
The APK alone is not enough for the text assistant and server-side Maps:
```bash
cd functions && npm run build && firebase deploy --only functions
```
* `assistantTurn` validates the model's tool calls against its **own** copy of `shared/tools.ts`.
  Until it is redeployed, `set_destination {query}` ("AI, take me to City Hospital") is rejected in
  text chat, and the old prompt still says maps need GPS.
* `mapsSearch` / `mapsAutocomplete` accept a search **without** GPS (no lat/lng) only after the deploy.
  Before it, destination search without a fix uses only the in-app browser-key fallback.
* Voice mode (Gemini Live, `src/core/ai/liveSession.ts`) uses the app's own `shared/tools.ts` and works
  with the new APK alone.

## Docs
* [INTEGRATION_STATUS.md](INTEGRATION_STATUS.md): what is real, what is demo-only, known issues, test results
* [DEVICE_PROTOCOL.md](DEVICE_PROTOCOL.md): stick ↔ phone protocol v1 (provisioning, HMAC auth, telemetry)
* [FIREBASE_SCHEMA.md](FIREBASE_SCHEMA.md): data model, security model, write rates, functions
* [docs/ANDROID_SETUP.md](docs/ANDROID_SETUP.md): Firebase / Maps / Gemini / FCM setup, permissions, build
* [docs/GOOGLE_CLOUD_SETUP.md](docs/GOOGLE_CLOUD_SETUP.md): billing, APIs, browser / server / Gemini keys, App Check, deploy, and "message in the app → what to do" (the in-app Server & maps test points here)
* [docs/DEVICE_DEBUG.md](docs/DEVICE_DEBUG.md): real-device test steps (camera view, live video, AI vision, maps, stick link) and what to send when something fails
* [docs/DOCTOR.md](docs/DOCTOR.md): `npm run doctor`, the one command that checks the PC (including the Maps browser key), builds and installs the app
* [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md): feature traceability matrix, classification, release gates
* [docs/FIRMWARE_SETUP.md](docs/FIRMWARE_SETUP.md): the owner's pin map audited, electrical conditions, power
* [docs/FIRMWARE_SETUP.md](docs/FIRMWARE_SETUP.md): ECU modules, build/flash, hardware test procedure, OTA design
* [PAIRING_FLOW.md](PAIRING_FLOW.md) · [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) · [AUDIO_ARCHITECTURE.md](AUDIO_ARCHITECTURE.md) · [CAMERA_PRIVACY.md](CAMERA_PRIVACY.md) · [SECURITY.md](SECURITY.md)

## Brand and design
* Product name: `src/core/brand/brand.ts`. Logo: **one file**, `src/core/brand/logo.svg` (also the favicon).
* Colours: semantic tokens in `src/styles.css` (brand/teal, success/ok, warning/amber, emergency/sos,
  info, muted). Components never use raw palette colours.
