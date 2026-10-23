# Build AI SmartStick from the source

Start here for the separate **SmartStick user** and **Guardian** apps. This guide, [wiring](HARDWARE.md), [firmware setup](FIRMWARE_SETUP.md) and [dual-app setup](DUAL_APP_SETUP.md) supersede older setup notes.

ESP32-CAM firmware handles sensors/motor warnings; the user app handles local detection, walking decisions, navigation and audio; Firebase provides accounts, Guardian sharing and Maps/Gemini tools. Local warnings must work offline. Camera labels do not establish metric depth or clear corridors.

## 1. Choose your starting point

- **Try the existing build:** download [SmartStick user APK](https://github.com/ParthSancheti/AiSmartStick/releases/download/v0.2.0-prototype-20261018/AI-SmartStick-user.apk) and [Guardian APK](https://github.com/ParthSancheti/AiSmartStick/releases/download/v0.2.0-prototype-20261018/SmartStick-Guardian.apk). These debug test builds use the maintainer's backend; cloud access requires authorization/App Check.
- **Rebuild your own system:** follow every step below using your own Firebase/Google Cloud project and signing configuration. An APK alone cannot supply a new backend or finish a physical stick.
- **Inspect the UI only:** run the local demo. Demo data does not test sensors, GPS, cloud availability or wiring.

## 2. Install tools and clone

Install Git, **Node 22.12+ in the Node 22 line**, npm, Android Studio with **JDK 21**, Android SDK **36**, Platform Tools and Command-line Tools. The source contains its Gradle wrapper. Use Android 10+ for the custom stick Wi-Fi flow. Install Arduino IDE 2 with **Espressif ESP32 core 2.0.17**, target **AI Thinker ESP32-CAM**. NX 10 is needed to edit the supplied native CAD; an STL slicer is sufficient for mesh inspection/printing.

```powershell
git clone https://github.com/ParthSancheti/AiSmartStick.git
cd AiSmartStick
npm ci
npm --prefix functions ci
```

Use the README's branch/tag if different from default. Keep lockfiles; `npm ci` prepares local detector assets.

For a Windows demo:

```powershell
$env:VITE_APP_MODE = "demo"
$env:VITE_APP_ROLE = "combined"
npm run dev
```

Open the localhost address printed by Vite. Stop it with Ctrl+C and clear these shell overrides before real development:

```powershell
Remove-Item Env:VITE_APP_MODE, Env:VITE_APP_ROLE -ErrorAction SilentlyContinue
```

## 3. Assemble and flash the stick

1. Review [parts and wiring](HARDWARE.md), including the owner's 2500 mAh battery, power-bank module and NPN-only motor description. Verify ratings and fit required protection components.
2. Inspect [CAD and enclosure assets](../hardware/README.md); verify physical fit and mesh scale before printing.
3. Bench-wire with power disconnected. Fit ECHO level protection and the motor driver/diode. Verify rails and sensor polarity with a meter.
4. Open `firmware/ai_smart_stick_v1/ai_smart_stick_v1.ino` in Arduino IDE. Keep all sibling sources and `partitions.csv` together. Select core **2.0.17**, **AI Thinker ESP32-CAM**, correct COM port, 4 MB flash and working PSRAM. `ArduinoJson.h` is bundled.
5. Verify, then upload following [Firmware setup](FIRMWARE_SETUP.md). The custom app slot is **1,310,720 bytes**. Use a 3.3 V-logic programmer, GPIO0 LOW at reset for download mode, and release the GPIO3 button. Remove the programming strap and reset for normal boot.
6. Inspect serial startup at **115200 baud**. Verify device model/protocol and live sensor readings before enclosure assembly. Keep credential-bearing serial logs private.

Production firmware starts the `SmartStick_AI` AP; inspect `BoardConfig.h` for its configured passphrase and change shared credentials only with matching app configuration. The AP has no internet. Never use routine factory reset as a normal connection or reflash step. Do not flash the [historical diagnostic sketch](../hardware/README.md#which-firmware-to-use) for current app operation.

## 4. Create your backend configuration

1. Create/select a Firebase project with billing for Cloud Functions/Secret Manager. Enable Google Authentication, Firestore, Storage and Cloud Messaging as needed.
2. Register a Firebase Web app and two Android apps: **`in.aismartstick.app`** and **`in.aismartstick.guardian`**. Add the SHA-1/SHA-256 fingerprints of the certificates you actually use. Put the downloaded configurations at ignored `android/app/google-services.json` for user and `android/app/src/guardian/google-services.json` for Guardian.
3. Copy `.env.example` → `.env`, and `functions/.env.example` → `functions/.env`. Fill your Firebase web fields, region, restricted Maps browser key/Map ID and optional web notification settings. Keep `VITE_APP_MODE=real`. All `VITE_*` values ship to clients; Gemini/server keys must never go there.
4. Enable Maps JavaScript API for map rendering and Places API (New), Routes API and Geocoding API for backend tools. The browser key needs website restrictions for `https://localhost/*` and your hosted origins. Use a separate restricted server key for backend APIs.
5. Configure available Gemini Live and vision/text models in `functions/.env`. Template model names are project defaults; verify access in your own account. Keep App Check enforcement enabled. For sideloaded debug APKs use `VITE_APPCHECK_DEBUG=true` and register the installation's private debug token in Firebase App Check. Use production integrity configuration for public release; do not disable enforcement to hide setup failures.

Install the Firebase CLI, sign in and choose **your** project:

```powershell
npm install --global firebase-tools@15.33.0
firebase login
firebase use --add
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set MAPS_SERVER_KEY
npm run functions:build
firebase deploy --only functions,firestore,storage
```

Secrets are prompted privately; deployment can incur charges. Set Authentication authorized domains/API restrictions; see [Google Cloud setup](GOOGLE_CLOUD_SETUP.md). Configure Guardian HTTPS/web push/TURN as needed.

## 5. Build and install both Android apps

Set `JAVA_HOME` to JDK 21 and point `ANDROID_HOME` to the SDK; Android Studio can create ignored `android/local.properties`. Accept SDK licences. Keep the existing custom `android/` project: **do not run `cap add android`**.

```powershell
npm run typecheck
npm test
npm run functions:build
npm run apk:user
npm run apk:guardian
```

Run role builds **sequentially**: each builds real-mode web assets, syncs Capacitor and compiles the matching native package. Outputs are `deliverables/AI-SmartStick-user-debug.apk` and `deliverables/AI-SmartStick-guardian-debug.apk`. This avoids placing user controls inside the Guardian package. See [dual-app setup](DUAL_APP_SETUP.md).

Enable USB debugging, connect by data cable and approve the computer:

```powershell
adb devices
adb install -r deliverables/AI-SmartStick-user-debug.apk
# Run against the Guardian's connected phone:
adb install -r deliverables/AI-SmartStick-guardian-debug.apk
```

With multiple phones add `adb -s SERIAL`. Resolve signing mismatches without immediately uninstalling user data. Public releases require your signing identity registered with Firebase/Google/App Check and incremented version codes.

For Guardian web hosting, build `npm run build:guardian`, then `firebase deploy --only hosting`. The hosting target serves `dist/`. Restore a user build before syncing/installing the user package again.

## 6. First run and acceptance

1. Sign in using separate user and Guardian Google accounts; complete the existing pairing-code flow. An account's existing backend role is preserved.
2. In the user app, grant requested precise location, Nearby devices, microphone and notification permissions. Keep mobile data available while the phone connects to the stick AP.
3. Complete stick setup. Verify advancing telemetry counters, real range/IMU readings, battery voltage/current and fresh camera frames. A missing sensor or unknown status must remain unknown.
4. Close any browser `:81/stream` viewer before testing app snapshots; only one viewer can own the camera and capture may legitimately report busy.
5. Run **Server & maps test**, then ask the assistant “What is in front of me?” Verify actual camera scene response. Check a Google login completes once without opening a second picker while verification is pending.
6. On the bench, test known obstacle distances, motor warnings with phone/internet disconnected, stale sensors, reconnection, camera motion, navigation pause/resume and audio interruption. Test screen-off/return, restart and saved distance on the real phone. GPS gaps cannot reconstruct unmeasured travel.
7. Test Guardian location/push/camera from a second phone/network. Test SOS only with an informed test contact and confirm the actual delivery/composer result.
8. Begin supervised walking trials in a controlled, level area with a sighted companion and normal mobility aid. Record mount angle, speed, false/missed warnings, response delays, battery voltage and phone/firmware versions. Do not start with roads, stairs or drop-offs.

The camera can miss/mislabel objects. One sonar and monocular images cannot establish side clearance, terrain/head-height coverage or crossing safety. Software/replay tests do not certify a mobility product.

## 7. Repeatable software checks and troubleshooting

```powershell
npm run typecheck
npm test
npm run test:walking-native
npm run functions:build
npm run algorithm:build
npm run algorithm:smoke
```

Firmware host tests use `npm run test:firmware` in a Bash/Linux/WSL environment with C++17 `g++` (the script uses `/tmp` and shell chaining). They do not replace an ESP32 target compile or physical motor test.

| Symptom | Check |
|---|---|
| Boot failure/reset during motor start | Supply headroom, GPIO12 reset level, driver/ground wiring and programmer conflicts. |
| Connected stick, cloud unavailable | Mobile-data internet route, Firebase auth, registered App Check token, deployed Functions and backend model access. |
| Google picker returns but account pending | Firebase certificate fingerprints, matching package configuration, network/profile acknowledgement and correct account role. |
| Camera busy | Close external MJPEG viewers; retry after the active capture owner releases it. |
| Implausible battery percentage | Battery-side INA219 placement, polarity, shunt value and measured voltage/current. |
| Wrong app role/build | Run `apk:user` or `apk:guardian`; do not change only a Gradle property. |

Keep `.env`, Firebase native configuration, signing keys, App Check tokens and raw private device logs out of Git. Share redacted errors and reproducible steps when requesting help.
