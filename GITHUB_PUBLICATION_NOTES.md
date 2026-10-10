# GitHub publication and validation notes

Branch: `refinement/walking-guidance-and-battery` in `ParthSancheti/AiSmartStick`. The existing `main` branch is unchanged. Start with [the complete setup guide](docs/SETUP.md).

## Source provenance

- Original selected repository: `main` at `8baa6ba3fbe1afcb0f2f69ea1cc5f64f69b293ba`.
- Authoritative app/firmware input: the user's uploaded `smartstick.zip`, SHA-256 `49e40156b90931012effd8924c04408b404f0f6ea02172f559407d253f6f16ac`, with the documented battery/walking refinements applied.
- Matching existing Android and native-check support: recovered from repository branch `claude/eloquent-ptolemy-s5yf7c`, commit `c37f44268a6b969e6802f6c24e7d75f88950dc95`. Its TypeScript native contracts, Capacitor configuration and package lock matched the upload. This recovers existing project implementation; it does not add a new audio system or rewrite the native adapters.
- Repository files outside the uploaded source are retained, except the old bundled `index.zip` and generated `.firebase` hosting cache, which are removed from this branch's tracked files but retained locally. The old ZIP embeds local environment files and is unnecessary for building the source.

The branch combines the newer uploaded project with refinements, so its difference from the older `main` includes the user's existing changes as well as this sprint. The original refinement manifest `validation/source-changes.json` records the uploaded ZIP comparison; it is not an inventory of all publication/native recovery changes. Git records the integrated branch, while `validation/github-publication.json` records this publication validation.

## Setup-specific changes

- Added `docs/SETUP.md`, `docs/ANDROID_SETUP.md` and `docs/FIRMWARE_SETUP.md`; linked them from README and corrected obsolete demo/test/Guardian command references.
- Recovered matching `android/` and `android-typecheck/` source/support trees, including `AissLocationPlugin` and registration. Native Wi-Fi routing, HTTP headers/binary body, MJPEG streaming, GPS and foreground-service APIs match the existing app contracts in source.
- Removed duplicate, machine-specific `org.gradle.java.home` entries. Each developer selects JDK 21 through `JAVA_HOME` or Android Studio.
- Extended `.gitignore` for project-specific `.env.*`, signing material and local generated state. No local `.env`, `.firebaserc`, `google-services.json`, signing key, server-secret value or generated Functions/WASM output is newly committed. GitHub provides the source ZIP directly from the branch; no locally configured project archive is uploaded.

## Integrated-checkout checks

Frozen root and Functions installs succeeded with **Node 22.23.3**. The integrated checkout passed:

- App tests: **673 passed, 0 failed, 62 files**.
- Firmware host checks: **64 safety/guard + 45 actual-main integration checks**.
- Production TypeScript/web build and `npm run android:sync`.
- Functions build, including shared-contract generation.

The unchanged uploaded Firestore rules had previously passed **15 emulator tests**; the refinement demo build and Chromium smoke had also passed. The matched native recovery does not change those app/rules sources.

Gradle **9.6.0** distribution download and `--version` succeeded after using the environment's existing HTTPS proxy; direct Java networking initially failed DNS resolution. No TLS or artifact verification was disabled. The cloud environment has a Java 21 **runtime**, but no `javac`/JDK compiler or Android SDK. A full Gradle APK build is **not** claimed. `cap sync` prepares native assets/dependencies; it does not compile an APK or prove phone behavior.

ESP32 target compilation/flash remains unverified: the prior authoritative Arduino/core downloads were rejected by the cloud proxy, and no physical board is attached. No Firebase resources, Functions, Hosting site, APK or firmware were deployed/flashed by this task.

## Real-device limits

PCM playback in the current source uses the shared Web Audio context through `UnifiedAudioOrchestrator`, including inside the Android WebView. The recovered native adapters are for connectivity, camera, location, device controls and lifecycle; there is no separate Android AudioTrack PCM bridge to certify.

The single forward HC-SR04 and camera cannot measure 150 m ranging or certify exact side clearance. Camera observations remain qualitative; side advice means stopped cane inspection. Actual battery savings, motor/detection latency, camera mounting, blind spots, navigation/Live/SOS behavior and Android screen-off continuity need controlled device validation. Software success is not physical safety certification.
