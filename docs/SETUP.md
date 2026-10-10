# AI SmartStick — complete setup

This guide is for `refinement/walking-guidance-and-battery`. It covers the phone app, Guardian web app, Firebase/Gemini/Maps backend and ESP32 stick. Start with the demo, then configure your own cloud project and native build, then validate the hardware.

The branch combines the uploaded project and tested refinements with the matching existing Android source recovered from commit `c37f44268a6b969e6802f6c24e7d75f88950dc95`. The Android project is included; do not replace it with a generated Capacitor project. Local environment files, signing keys, Firebase project selection and the old bundled ZIP are excluded from this branch. Fill the supplied templates locally.

## 1. Get the code and prerequisites

```bash
git clone --depth 1 --branch refinement/walking-guidance-and-battery --single-branch https://github.com/ParthSancheti/AiSmartStick.git
cd AiSmartStick
npm ci
npm --prefix functions ci
```

Use Node **22.12 or newer in the Node 22 line**; the refinement was originally installed with Node 22.23.3. Functions target Node 22. Use a **JDK 21**, rather than only a JRE, for Android and native Java checks. Android Studio needs **Android SDK Platform 36** and the existing Gradle wrapper. Firmware needs Arduino CLI or Arduino IDE with the pinned ESP32 core described below. The g++ host tests and `android:typecheck` shell helper need Bash/Linux/macOS/WSL or a compatible development shell.

Both dependency lockfiles are included. `npm ci` automatically prepares local MediaPipe WASM assets from the pinned dependency; the EfficientDet-Lite0 model is committed under `public/models/`. Functions build copies `shared/` into its generated source directory. Do not fetch a different model or hand-edit generated shared files.

## 2. Run the demo first

On Linux, macOS, WSL or Git Bash:

```bash
npm run dev:demo
```

On Windows PowerShell:

```powershell
$env:VITE_APP_MODE = "demo"
npm run dev
```

Open the address Vite prints, normally `http://localhost:5173`. Demo mode uses simulated devices and data. Use the existing role selection to try the stick-user or Guardian flow. The local demo does not need Firebase secrets, a phone or an ESP32, and does not validate hardware operation.

## 3. Configure Firebase, Maps and Gemini

1. Select your own Firebase/Google Cloud project. Cloud Functions and Secret Manager need billing/Blaze. Enable Authentication with Google sign-in, Firestore, Storage and Cloud Messaging as required by the existing app.
2. Register a **Web app** and an **Android app** with package `in.aismartstick.app`. Download your Android `google-services.json` into `android/app/`. Add your debug/release SHA-1 and SHA-256 signing fingerprints in Firebase. After adding fingerprints, download updated Android configuration.
3. Enable **Maps JavaScript API**, **Places API (New)**, **Routes API** and **Geocoding API** for the project used by the corresponding key. Enable Gemini access for the project/account used by the server Gemini key. Do not substitute a Maps Android SDK key for the Maps JavaScript browser key.
4. Copy the templates, then fill values locally:

   ```bash
   cp .env.example .env
   cp functions/.env.example functions/.env
   ```

   In PowerShell use `Copy-Item` instead of `cp` if needed. Set `VITE_APP_MODE=real` for real-device builds. Fill the six `VITE_FIREBASE_*` web configuration fields and `VITE_FIREBASE_FUNCTIONS_REGION=asia-south1`. Set a restricted `VITE_GOOGLE_MAPS_BROWSER_KEY` and, if available, `VITE_GOOGLE_MAPS_MAP_ID`. Configure web App Check and FCM VAPID only for the web functions you use.
5. Keep Gemini and Maps server keys in Firebase **Secret Manager**, never a `VITE_*` field. Select a currently available Gemini Live-compatible model for `GEMINI_LIVE_MODEL` and supported text/vision models for `GEMINI_FLASH_MODEL` and `GEMINI_VISION_MODEL` in local Functions configuration. The template names are existing project defaults; their availability in your account is not proven by a software build.
   For existing GitHub firmware-release metadata, set `GITHUB_FIRMWARE_OWNER=ParthSancheti` and `GITHUB_FIRMWARE_REPO=AiSmartStick` in your local Functions configuration. This branch does not publish a firmware binary or OTA release.
6. Keep App Check enforcement enabled. Register a debug token when testing a sideloaded APK; use Play Integrity for production Android and reCAPTCHA Enterprise for the web app. Do not use an App Check bypass as production setup.

Install the Firebase CLI and sign into your account:

```bash
npm install --global firebase-tools@15.33.0
firebase login
firebase use --add
```

Choose your Firebase project when prompted. Then set its two backend secrets:

```bash
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set MAPS_SERVER_KEY
```

The CLI prompts for the values. Do not paste them into source, a commit or an issue. Restrict the Maps browser key to its permitted web origins, including `https://localhost/*` for Capacitor and your Guardian hosting origins. Restrict keys to the APIs they need. Every `VITE_*` value is shipped to the app, so it cannot hold a server credential.

Read [Google Cloud setup](GOOGLE_CLOUD_SETUP.md) for API restrictions, App Check and existing Server & maps diagnostics. That older document includes an example project number: replace its project-specific links with your own project.

## 4. Build and deploy the backend and Guardian web app

```bash
npm run functions:build
firebase deploy --only functions,firestore,storage
npm run build
firebase deploy --only hosting
```

These commands deploy to the project selected by `firebase use`. They may provision billed resources; review the selected project before running them. Nothing was deployed by the refinement/GitHub publication task.

Firebase Hosting serves `dist/`. The existing shared app supplies the Guardian flow through its role selection; there is **no `build:guardian` command** in the current package. Add your hosting domain to Firebase Authentication authorized domains and browser-key restrictions. Configure the `VITE_FCM_VAPID_KEY` and HTTPS notification permission when testing Guardian web push.

Keep app and Functions tool contracts synchronized: rebuild/redeploy Functions when changing `shared/` or Functions source. Local walking detection runs on the stick/phone and needs no Gemini, Firebase or internet; cloud conversation and explicitly requested cloud photos remain separate features.

## 5. Build and install Android

Follow [Android setup](ANDROID_SETUP.md) for exact Firebase/signing/permissions details and the recovered native source. With JDK 21, SDK 36, Android Studio and `android/app/google-services.json` configured:

```bash
npm run android:sync
npx cap open android
```

In Android Studio, select JDK 21 as Gradle JDK and build/run the existing `android/` project on your phone. Do not run `cap add android` over it: custom Wi-Fi, camera, GPS and service plugins must remain registered.

For an existing configured developer machine, the project also provides:

```bash
npm run doctor -- --checks-only
npm run apk
npm run apk:install
```

`apk:install` builds a **debug APK** and installs it over USB; enable developer options/USB debugging and authorize the computer. The doctor can make local setup repairs; read [Doctor guide](DOCTOR.md). A release APK needs your own signing key and the appropriate production Firebase/App Check configuration. The repository does not include a signing key or a prebuilt/certified APK.

## 6. Wire, build and flash the stick

Read [Firmware setup](FIRMWARE_SETUP.md) before applying power. It gives the actual pin map, camera/I2C wiring, ECHO voltage protection, motor driver, battery/INA219 assumptions, custom partition and boot-strap precautions.

The pinned target is **Arduino-ESP32 2.0.17**, board **AI Thinker ESP32-CAM**, FQBN `esp32:esp32:esp32cam`. ArduinoJson is bundled; do not replace the firmware's safety parameters to make a build work. Arduino IDE can use the existing `ai_smart_stick_v1.ino`, or use the documented Arduino CLI procedure.

After installing the required toolchain, the existing helper can build without flashing:

```bash
npm run doctor -- --firmware
```

Adding a serial port also uploads, so use the correct connected board:

```bash
npm run doctor -- --firmware --port /dev/ttyUSB0
```

Use your actual serial port (for example `COM5` on Windows). The detailed guide documents boot/reset/serial steps and HTTP tests. The configured setup AP is shared between firmware and phone; change it only through a coordinated hardware/app configuration procedure.

## 7. Connect and verify real operation

1. Power the correctly wired stick and inspect its serial startup/health output.
2. On the phone, use the app's existing stick setup flow. Grant its requested Wi-Fi/location permissions and approve Android's device-network prompt. Keep mobile data available for Firebase/Maps/Gemini; the stick AP itself has no internet.
3. Check telemetry, camera capture, sensor freshness and raw range trend in existing diagnostics. Keep stick INA219 voltage/current separate from phone battery measurements.
4. Run the existing **Server & maps test** after real sign-in. Verify deployed Functions, App Check, map search/routes and Gemini Live. Explicit **Test AI vision** sends a user-requested cloud photo; it is not the local detector's safety path.
5. Verify local motor warnings with the phone disconnected and internet disabled; verify SafeMode/wake, sensor fault/staleness, fall behavior and SOS using supervised, controlled tests. Do not trigger an actual emergency contact unintentionally.
6. Test navigation pause/resume, camera scene labels, queued speech cancellation, Bluetooth/audio interruption, screen-off service continuity and reconnection on the actual phone/board before supervised walking trials. Existing software tests do not establish physical safety certification.

The hardware is one forward HC-SR04 plus a monocular camera. It cannot measure 150 m range or certify a metric lateral bypass. Camera sides are image observations, and side suggestions mean **stop and inspect with the cane**, not permission to step into an inferred clear lane. Existing GPS off-route rerouting is preserved.

## 8. Reproduce software checks

```bash
npm run typecheck
npm test
npm run test:firmware
npm run build
npm run build:demo
npm run functions:build
firebase emulators:exec --project demo-aiss --only firestore 'npm exec -- vitest run -c vitest.rules.config.ts'
```

The rules command needs Firebase CLI plus Java 21. `demo-aiss` is an emulator-only project ID. Host firmware tests require `g++` and exercise logic/drivers with stubs; they do not flash a board. Optional `npm run android:typecheck` compiles against an API-30 jar/stubs and needs `javac`; it is **not** a Gradle/API-36 APK build.

Refinement results: **673 app tests, 109 firmware host checks and 15 rules tests passed**, together with web/demo/Functions builds and type-checking. Read [battery/system report](../BATTERY_EFFICIENCY_REFINEMENT_REPORT.md), [walking guidance report](../WALKING_GUIDANCE_REFINEMENT_REPORT.md) and [GitHub publication notes](../GITHUB_PUBLICATION_NOTES.md) for provenance and current validation limits. Physical battery savings, walking response, APK behavior and ESP32 target build/flash remain separate validation requirements.
