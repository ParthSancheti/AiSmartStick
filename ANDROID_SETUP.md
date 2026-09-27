# Android setup — AI Smart Stick (user app) and Guardian

Package: `in.aismartstick.app` (Capacitor 8, minSdk 24; **stick setup needs Android 10+**, API 29).
Native code: `android/app/src/main/java/in/aismartstick/app/` — `AissNativePlugin.java`
(setup Wi-Fi, discovery, secure storage, audio route, calls/SMS, background service control, keep-screen-on),
`StickForegroundService.java` (background execution) and `MainActivity.java` (plugin registration).

**Build status:** the Gradle/APK build could not run in the authoring environment (Google Maven,
Gradle and the Android SDK are unreachable there). The native Java *is* type-checked against the real
Android API surface with `npm run android:typecheck` (android.jar API 30 + small Capacitor/AndroidX
stubs, `android-typecheck/`). Run the real build in Android Studio / CI first:
```bash
cd android && ./gradlew assembleDebug      # → app/build/outputs/apk/debug/app-debug.apk
```

## 1. Build
```bash
cp .env.example .env            # fill VITE_FIREBASE_*, maps key, VAPID, etc.
npm install
npm run android:sync            # VITE_APP_TARGET=user build + cap sync
npx cap open android            # Android Studio → Run
```
Guardian: `npm run build:guardian` and deploy `dist/` with `firebase deploy --only hosting` (PWA).
Or build a second Android flavor with `VITE_APP_TARGET=guardian`.

## 2. Firebase
1. Create a Firebase project (Blaze plan: Functions and outbound Maps/Gemini calls need it).
2. Add an **Android app** `in.aismartstick.app` and add the **SHA-1 and SHA-256** of your debug and
   release keys (`./gradlew signingReport`). Google sign-in fails without them.
   Download `google-services.json` to `android/app/` (it is git-ignored).
3. Add a **Web app** and put its config into `.env` (`VITE_FIREBASE_*`).
4. Authentication → enable **Google**.
5. App Check: register the Android app with **Play Integrity** and the web app with **reCAPTCHA
   Enterprise** (put the site key in `VITE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY`). Callables use
   `enforceAppCheck: true`. Register a debug token for emulators/dev devices.
6. Firestore (Native mode, `asia-south1`). Deploy with `firebase deploy --only firestore,storage`,
   then create the TTL policies from FIREBASE_SCHEMA.md.
7. Functions:
   ```bash
   cd functions && npm install
   firebase functions:secrets:set GEMINI_API_KEY
   firebase functions:secrets:set MAPS_SERVER_KEY
   cp .env.example .env         # GEMINI_MODEL=gemini-3.5-flash (Gemini 2.5 models shut down 16 Oct 2026)
   firebase deploy --only functions
   ```
8. Cloud Messaging: the Android channels `sos` (max importance) and `status` are created by the app.
   For the Guardian PWA create a Web Push certificate and set `VITE_FCM_VAPID_KEY`.

## 3. Google Maps Platform
* **Server key** (`MAPS_SERVER_KEY` secret): enable **Places API (New)**, **Routes API**, **Geocoding
  API**. Restrict it to those APIs. Every request uses a field mask.
* **Browser key** (`VITE_GOOGLE_MAPS_BROWSER_KEY`): enable **Maps JavaScript API** only. Restrict it
  to Android apps (package + SHA-1) and your web origins. Create a Map ID (`VITE_GOOGLE_MAPS_MAP_ID`),
  which advanced markers require.
* Set quotas/alerts in Cloud Console. The functions also enforce per-user quotas.

## 4. Gemini
* Key only in Secret Manager (`GEMINI_API_KEY`). The app never sees it.
* `GEMINI_MODEL` / `GEMINI_VISION_MODEL` default to `gemini-3.5-flash`.
* Gemini Live (realtime audio) was evaluated and is not used in this phase: every action must pass the
  app's validated tool executor, and the physical-button push-to-talk model maps cleanly to turn-based
  calls. A Live adapter can later replace STT/TTS while keeping the same tool layer.

## 5. Permissions (manifest) and why
| Permission | Used for | If denied |
|---|---|---|
| `ACCESS_FINE/COARSE_LOCATION` | GPS navigation, SOS location, walk distance; Wi-Fi scan on Android ≤ 12 | "Location unavailable"; the stick still works |
| `NEARBY_WIFI_DEVICES` (neverForLocation) | Finding the stick's setup network on Android 13+ | Setup shows how to allow it |
| `ACCESS/CHANGE_WIFI_STATE`, `CHANGE_NETWORK_STATE`, `CHANGE_WIFI_MULTICAST_STATE` | `WifiNetworkSpecifier` setup connection, UDP discovery | — |
| `INTERNET`, `ACCESS_NETWORK_STATE` | Firebase, Maps, Gemini (via Functions), stick HTTP | — |
| `RECORD_AUDIO` | Speech recognition (push-to-talk) | Typing in the Assistant screen still works |
| `POST_NOTIFICATIONS` | FCM (SOS acks, camera requests, guardian alerts) | In-app only |
| `CALL_PHONE` *(optional)* | Direct call to the guardian | Dialer opens with the number (reported as "dialer opened") |
| `SEND_SMS` *(optional)* | Direct SOS text when offline | Messages app opens with the text (reported as "composer opened") |
| `VIBRATE`, `WAKE_LOCK` | Haptics, background wake lock | — |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `FOREGROUND_SERVICE_LOCATION` | Background execution (§7). Play Console requires a foreground-service declaration with a video | App works in the foreground only |

**Google Play policy:** `SEND_SMS` and `CALL_PHONE` are restricted permissions. Direct SMS needs an
approved Permissions Declaration (safety/emergency use) or must be removed. The app already works without
them and never claims "sent" when only the composer opened. Remove both lines from the manifest if you
won't file the declaration.

## 6. Stick networking notes
* The stick joins the **phone's hotspot (2.4 GHz)**. On phones with "Extend compatibility" or a band
  option, pick 2.4 GHz.
* Android does not let apps read or set the hotspot password, so the user types it once during setup.
  (LocalOnlyHotspot was considered and rejected: its credentials change on each start and it is often 5 GHz.)
* Many phones cannot be connected to the stick's setup AP and run their hotspot at the same time, so the
  setup flow sends credentials first, then asks the user to turn the hotspot on.
* Stick HTTP is cleartext on the local hotspot, so `network_security_config.xml` permits cleartext. Every
  stick request is HMAC-signed and the stick must prove its key. All cloud traffic is HTTPS.
* `CapacitorHttp` is enabled so WebView `fetch()` to `http://<lan-ip>` goes through native HTTP.
* The device key is kept in `EncryptedSharedPreferences` (Android Keystore), never in Firestore.

## 7. Background execution (foreground service)
`StickForegroundService` keeps the app process (and its WebView JS runtime) alive when the screen is
off or another app is in front. It uses a persistent low-importance notification, service types
`connectedDevice` (plus `location` when location permission is granted), and a partial wake lock.
Capacitor's WebView keeps its timers running while paused (`KeepRunning` default).

* `core/native/background.ts` starts the service automatically when "Keep running with the screen off"
  is on (Settings → Camera & Location, default on) **and** one of these is true: a stick is paired, an
  SOS is active, or navigation is running. It stops otherwise.
* The notification always states the real situation, for example "Stick connected · SOS ready",
  "Stick reconnecting", "SOS active — sharing your location" or "Walking to City Pharmacy".
* Android 12+ forbids starting a foreground service from the background. The controller starts it
  while the app is visible (on pairing, SOS or navigation start). If Android refuses, the setting shows
  the error; nothing pretends to run.
* **Process death / swipe-away:** the service is `START_NOT_STICKY`. If Android restarts it without the
  app, or the user swipes the app away, it shows "AI Smart Stick stopped — tap to resume" and stops,
  instead of a notification that falsely claims protection. It also stops on sign-out and unpair.
* **Battery optimisation:** Settings → Camera & Location shows whether the app is exempt
  (`PowerManager.isIgnoringBatteryOptimizations`) and opens the system list, where the user chooses
  "Don't optimise". The restricted `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission is not used.
* **Pocket mode** sets `FLAG_KEEP_SCREEN_ON` while the touch shield is shown. If the screen still
  turns off, the foreground service keeps the stick, GPS, SOS and sync running.
* **OEM battery managers** (Xiaomi/Redmi MIUI/HyperOS, Samsung "Sleeping apps") can still kill
  background apps. Ask users to set AI Smart Stick to "No restrictions" / "Unrestricted". This must be
  verified on each target phone (hardware test H-10 in INTEGRATION_STATUS.md).

## 7b. Plugin notes
* **Contact picker:** `AissNative.pickContact()` uses the system picker (`ACTION_PICK` on phone numbers). It needs no `READ_CONTACTS` permission, and only the chosen contact is returned. On the web it uses the Contact Picker API where supported; otherwise the contact is typed.
* `android/variables.gradle` sets `rgcfaIncludeGoogle = true`. Native Google sign-in
  (`@capacitor-firebase/authentication`) needs it.
* QR pairing uses `@capacitor-mlkit/barcode-scanning` with the **Google code scanner**. There is no
  camera permission and the system UI does the scan. On first use the app installs the scanner module
  from Play services.
* `@capacitor-community/speech-recognition` is 7.x (the latest published) on Capacitor 8. It is
  declared compatible by npm peer ranges, but verify it on a device.
* App Check in debug builds: register the debug token printed in Logcat in the Firebase console, or
  callables will be rejected.

## 8. Device checklist (first run)
1. Sign in with Google → scan the Guardian's QR (or type the 6-digit code).
2. Hold the stick button 5 s → "Stick detected" → type the setup code + hotspot name/password → tap
   **Connect** on the Android sheet → turn the hotspot on → "AI Smart Stick Connected".
3. Settings → Hardware → **Find My Stick** (vibrates) and **Calibrate orientation** (hold the stick upright).
4. Safety Center → **Run check**.
