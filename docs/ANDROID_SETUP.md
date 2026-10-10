# Android setup and native integration

Use the existing `android/` project in this repository. It contains custom device-networking,
secure-storage, audio-route, call/SMS, and foreground-service code. `npx cap sync android` updates
dependencies and bundled web assets; it does not implement custom plugin methods. Do not delete
this directory or run `cap add android` over it to resolve an integration problem.

The custom Android implementation matching the uploaded application was recovered from the existing
repository revision `c37f442`. Its native plugin contracts are present; no replacement audio or
device architecture was introduced. A successful web build or APK installation still does not
establish physical-device correctness or battery savings.

## 1. Toolchain

| Prerequisite | Project requirement |
| --- | --- |
| Node.js | Use Node 22.12 or newer supported LTS. Capacitor 8 requires Node 22+, and Vite 8 requires Node 20.19+ or 22.12+. The integrated branch was verified with Node 22.23.3; the host also provides Node 24.19.0. |
| npm | Use `npm ci` with the committed `package-lock.json`; do not replace the lockfile to work around installation failures. |
| Java | JDK 21. `android/app/capacitor.build.gradle` compiles Java with `VERSION_21`. Set `JAVA_HOME` to a local JDK 21 installation. |
| Android SDK | Platform API 36, compatible Build Tools, Platform Tools (`adb`), and Command-line Tools. Install through Android Studio's SDK Manager and accept the SDK licenses. |
| Android Studio | Use an installation compatible with the committed Android Gradle Plugin and JDK 21. Open the existing `android/` project. |
| Phone | The manifest minimum is Android 7/API 24. The retained custom Wi-Fi setup implementation requires Android 10/API 29 or later; use a physical phone for stick acceptance tests. |
| Host tests | `g++` with C++17 for firmware host tests. The optional native stub check also requires `javac`, Bash, and `curl`. |

The audited retained project pins Android Gradle Plugin **9.4.1** in `android/build.gradle`,
Gradle **9.6.0** in `android/gradle/wrapper/gradle-wrapper.properties`, and compile/target SDK **36**
in `android/variables.gradle`. Availability and a complete build of those pinned artifacts must be
checked on the build machine. If resolution fails, record the exact artifact failure and investigate
the supported Capacitor toolchain; do not silently swap versions or disable TLS/checksum checks.

Use `JAVA_HOME` or Android Studio's explicitly selected Gradle JDK rather than committing a
machine-specific `org.gradle.java.home`. The commands below also pass
`-Dorg.gradle.java.home="$JAVA_HOME"` explicitly. If a local configuration still forces a nonexistent
JDK path, the project's doctor can comment invalid paths out with `--fix`; review that diff.

Set `ANDROID_HOME` to your local SDK installation. Android Studio can create ignored
`android/local.properties` with `sdk.dir` for this machine; the doctor can create it too. Do not commit
SDK paths or copy another machine's `local.properties`.

## 2. App identity, Firebase, and Maps

The application identity is **`in.aismartstick.app`** in both `capacitor.config.json` and
`android/app/build.gradle`. Keep those identities aligned with the Firebase Android app and signing
certificates. The authoritative Capacitor configuration is JSON, with `webDir: "dist"`.

1. Reuse existing `.env` configuration where present. Otherwise copy `.env.example` to `.env` and
   enter your own Firebase web configuration and Maps browser key/Map ID. Every `VITE_*` value is
   embedded in the web bundle; server Gemini/Maps secrets do not belong there.
2. Register or select the Firebase Android app for this package. Download its matching configuration
   to ignored `android/app/google-services.json`. The Gradle script conditionally skips the Google
   Services plugin when that file is absent; a build can therefore succeed with Firebase native
   services unconfigured.
3. Enable the intended Firebase sign-in providers. Add the SHA-1/SHA-256 fingerprints for each
   development/release certificate in Firebase and download an updated configuration when required.
   `android/variables.gradle` enables the native Google provider, and the uploaded Capacitor config
   uses `FirebaseAuthentication.skipNativeAuth: false`.
4. Restrict the Maps browser key for the WebView origin `https://localhost/*` and for the development
   origins you actually use. This map runs through Maps JavaScript in the WebView; an Android-only
   key restriction does not substitute for its website restriction. Keep server keys in the backend.
5. For a debug/sideloaded build, set `VITE_APPCHECK_DEBUG=true`, register that installation's debug
   token in Firebase App Check, and retain backend App Check enforcement. Treat the debug token as a
   credential; do not commit it or paste raw logcat into public issues. For distribution, use the
   production App Check provider and the appropriate Play signing certificate.

For cloud prerequisites, see [Google Cloud setup](GOOGLE_CLOUD_SETUP.md) and the repository's main
setup instructions. Do not follow a troubleshooting shortcut that disables authentication, App
Check, certificate validation, or transport signing to make a test pass.

Get certificate fingerprints from the existing project, after the toolchain resolves:

```bash
bash android/gradlew -p android -Dorg.gradle.java.home="$JAVA_HOME" :app:signingReport
```

Debug builds use the developer's debug certificate. The audited `app/build.gradle` has no configured
release signing identity. For release, use Android Studio's signed bundle/APK flow or your managed
CI signing configuration, increment the version code, and store keystores/passwords outside tracked
files. Check ignored-file rules before placing any signing material in the checkout. Changing the
signing certificate prevents updating an installed build signed with a different certificate; do
not uninstall a user's working installation just to resolve that mismatch.

## 3. Install, validate, and sync

Run from the repository root. These are commands to execute, not a claim that an Android build has
already passed:

```bash
npm ci
npm run typecheck
npm test
npm run test:firmware
npm run build
npx cap sync android
```

`npm run android:sync` combines the last two commands. Installation/build hooks copy the MediaPipe
WASM assets into `public/mediapipe/wasm/`; the EfficientDet model and worker remain local to the app.
If a model/WASM download fails, resolve access to the configured source and rerun the supported asset
script. Do not introduce cloud inference into the safety pipeline.

Check `git diff` after sync. Preserve `AissNativePlugin.java`, `StickForegroundService.java`,
`MainActivity.java`, the manifest, network-security XML, and signing configuration. Sync is not a
replacement for comparing the TypeScript plugin contract with its Java implementation.

For a debug APK and installation on an authorized USB-debugging phone:

```bash
adb devices
bash android/gradlew -p android -Dorg.gradle.java.home="$JAVA_HOME" :app:assembleDebug
bash android/gradlew -p android -Dorg.gradle.java.home="$JAVA_HOME" :app:installDebug
```

The APK output is `android/app/build/outputs/apk/debug/app-debug.apk`. On Windows, use
`android\gradlew.bat` with the corresponding `JAVA_HOME` path, or open the existing project in
Android Studio. USB authorization, package-signing compatibility, and native prerequisites are
separate from web compilation.

`npm run android:typecheck` uses the retained `android-typecheck/check.sh`, an API-30 Android JAR and
small Capacitor/AndroidX stubs. It catches a limited set of Java signature errors. It is not an
API-36 Gradle build, permission test, or TypeScript/Java contract parity test.

## 4. Doctor commands

```bash
npm run doctor -- --checks-only
npm run doctor -- --dry-run
npm run doctor
```

`--checks-only` inspects configuration and tooling without running the build pipeline; it can make
configured service checks and writes `doctor-report.txt`. `--dry-run` previews actions.
The default doctor runs typecheck, unit tests, firmware host tests, the web build, and Capacitor sync.
An Android APK build is an additional step.

`npm run doctor:fix` can run `npm install`, repair local SDK/JDK paths, and rename/re-encode
configuration files. `npm run apk` adds `--fix --apk`; `npm run apk:install` also installs via adb.
Use the explicit commands above when you need a frozen dependency installation. Review any doctor
changes, including lockfile changes, and do not use `--skip-tests` as evidence of readiness.

`npm run logcat` streams Android logs. Review logs locally before sharing: an App Check debug token,
device identifiers, addresses, or contact information can appear in native logs.

## 5. Custom native integration

`MainActivity` registers both **AissNative** and **AissLocation**. Keep their Java implementations
aligned with `src/core/native/aissNative.ts` and `aissLocation.ts`. The recovered matching native
tree implements the following contracts; each runtime behavior still requires an Android check:

| App contract | Existing native implementation |
| --- | --- |
| `getCurrentWifiSsid`, `connectToSetupNetwork` | Wi-Fi status/binding, requested SSID/passphrase and timeout, visibility checks, reuse of existing connections, and the Android connection sheet. |
| `setupRequest`/`requestBinary` | Supplied HTTP headers, per-request route selection, JSON/binary POST bodies, base64 JPEG replies, and network-route metadata. Retain signed device requests. |
| `startStream`/`stopStream`, `streamFrame`/`streamState` | Native MJPEG reader with a frame-rate limit, reconnects, socket close on stop, and orphan-listener cleanup. Snapshots are the existing fallback. |
| `setProcessBinding` | Last-resort process-wide routing toggle. This can redirect cloud traffic onto the stick's Wi-Fi; use the established fallback policy and test release of the binding. |
| `getFontScale`, `setStatusBarIcons`, settings launchers | Android system font-scale query, system-bar updates, and Wi-Fi/location/app settings recovery. MainActivity pins WebView text zoom to 100% while the app applies its own text-size setting. |
| `AissLocationPlugin` | LocationManager GPS/network/provider updates, precise/approximate permission state, provider diagnostics, cached/fresh fixes, and location/status events. Capacitor/WebView fallbacks remain available. |
| `startBackgroundService({ promote })` | In-place notification updates and foreground promotion. The manifest/service includes connected-device, location, and microphone types, conditionally applied according to permissions. |
| Keystore, audio route, contact picker, call/SMS | Existing secure storage, route query and system communication bridges. Test actual radio result and denied-permission fallback. |

The earlier main-branch native implementation lacked several of these contracts. Keep the recovered
matching files when merging or syncing, including `AissLocationPlugin.java`, microphone permissions,
and backup/data-extraction rules. Do not resolve an old-APK method error by weakening authentication
or by recreating `android/`. TypeScript tests with mocked plugins do not prove native runtime parity.

## 6. Audio, Wi-Fi, and permissions

Gemini Live receives/sends realtime audio through the existing Live session and plays returned
24 kHz PCM through `UnifiedAudioOrchestrator`/`audioManager` on the shared **Web Audio AudioContext**.
The audited Android tree has no AudioTrack PCM bridge. Native text-to-speech/speech recognition and
the `AissNative.getAudioRoute` query are separate integrations already used by this application.
Keep the current single audio owner and interruption behavior; do not add a second PCM/audio system
to compensate for a missing native method. Test the first user gesture, microphone permission,
Bluetooth/wired routing, critical interruptions, and lock/unlock on the target phone.

The retained Wi-Fi plugin uses `WifiNetworkSpecifier` on Android 10+ and performs per-network HTTP
requests, allowing the default internet network to remain separate. The current manifest/network
security XML permits cleartext for the ESP32 LAN, and the uploaded Capacitor config allows mixed
content with `CapacitorHttp.enabled: false`. Cloud endpoints remain HTTPS. Preserve HMAC/device
verification and validate simultaneous mobile-data cloud traffic plus stick traffic; enabling global
process binding can change that behavior.

Location and Nearby devices permissions support setup/discovery; microphone supports conversations;
notifications support foreground/SOS visibility. Request precise location for walking directions.
Approximate GPS can be useful for SOS, but does not establish adequate walking guidance accuracy.
Only grant/request permissions through the existing app flow and inspect denied-permission recovery.

Direct SMS uses the existing SEND_SMS bridge; a phone without permission/radio support can fall back
to the system composer. Direct calls similarly fall back to the dialer. SEND_SMS is restricted by
Google Play policy: assess eligibility for your intended distribution before release and accurately
test/report the composer path. Do not describe opening a composer as a sent SOS message.

## 7. Background behavior and acceptance limits

The retained foreground service shows a persistent notification and holds a partial CPU wake lock.
Location/microphone service types are acquired while the activity is in the foreground; notification
updates reuse the service. If Android refuses while-in-use types, the service can retain the
connected-device type and reacquire the others on a later foreground promotion. Start from the
existing foreground app flow with permissions granted before testing a locked-screen conversation.
It is `START_NOT_STICKY`; task removal stops it and shows a paused notice. The service does not
independently run the web safety/navigation logic after the app process is killed. A wake lock or
foreground notification does not prove that the WebView, GPS, camera, or PCM remains responsive with
the screen off. Android 12+ service-start restrictions, Android 14+ while-in-use rules, and OEM power
management require real-device checks. Do not enable deeper sleep or weaken local sensor safety to
make this build appear efficient.

Browser demo mode (`npm run dev:demo` or `npm run build:demo`) uses simulated device behavior and is
useful for app-flow checks. The real build uses `dist`; the demo build writes `dist-demo`. On Windows,
set `VITE_APP_MODE=demo` in the shell before invoking Vite if the POSIX demo script syntax is
unsupported. Demo output cannot validate native plugins, ESP32 timing, INA219 current, real GPS,
SOS radio behavior, or Android battery/thermal consumption.

Before distributing a real-device build, record: authenticated stick connectivity; one active
camera/inference loop with fresh-frame/resource counters; GPS freshness and off-route/obstacle
prompt handling; one Live session and correct audio interruption; SOS delivery result; denied
permission recovery; screen-off and return behavior; and process/task removal behavior. Read
[the refinement report](../BATTERY_EFFICIENCY_REFINEMENT_REPORT.md) for measured host results and the
remaining hardware requirements. Existing device guides contain intended scenarios; the integration
contracts above describe source support, while native streaming and background continuity remain
subject to physical acceptance testing. Software tests do not constitute physical safety
certification.
