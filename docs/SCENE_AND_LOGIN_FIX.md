# Scene analysis and Google sign-in fixes

This records the 18 October 2026 fix and installed-phone checks. Raw `validation/` logs referenced below were preserved in the private local backup during [cleanup](CLEANUP.md); they are not public repository downloads. See [the verification guide](VERIFICATION.md) for repeatable software checks.

## Scene analysis

The reported scene request reached the server with valid authentication, then the upstream image model timed out. The old implementation flattened that failure into an unavailable error, which the phone described as a network connection failure. It was intermittent: the old deployment also succeeded in one phone baseline request.

The vision service now uses the live-tested Gemini 3.5 Flash-Lite configuration with MINIMAL thinking, one bounded 20-second attempt and no automatic fallback/retry. Safe timeout, quota, configuration and upstream error categories survive the callable/client boundary. The ordinary scene button and assistant tool now explain the actual failure rather than misdiagnosing the phone connection.

`assistantVision` and `serverPing` were deployed successfully. An authenticated request from the connected phone using the bundled public test image returned HTTP 200 with a valid spoken result in 5.906 seconds after deployment. The exact model configuration also passed direct live probes. These measurements are individual smoke tests, not guaranteed service latency or availability. Detailed root-cause evidence and primary documentation are in `validation/SCENE_SERVER_FIX_2026-10-18.md`.

Authentication and App Check policy were not relaxed by this fix. The pre-existing App Check configuration warning is separate from the reproduced model timeout.

## Google sign-in

The native Google/Firebase credential operation finished before the asynchronous account-role/profile read. The old code immediately reset `busy`, making the Google button clickable again while profile verification was still running. A second tap opened another picker.

Google selection and account verification now share a single operation. Repeated calls reuse that operation, and both user and Guardian onboarding keep the button locked with explicit progress until account verification finishes. Profile verification has a 12-second bound. Retry uses the already authenticated identity instead of opening another Google popup.

Acknowledged accounts can restore from cache, including queued mutable profile edits, using the previously verified UID and immutable role. A first registration requires an acknowledged transaction. Role mismatches remain rejected. Generation and credential guards discard late OAuth, profile and registration results after cancellation, sign-out or listener disposal. The fixes passed independent code review.

No sign-out or account-data clearing was performed on the connected phone for this test. Native Google picker reauthentication was not forced on the existing account; delayed-profile, duplicate-call, cancellation, offline, role and stale-identity behavior were verified with automated regressions.

## Build and software verification

- Full suite: **955 tests passed across 80 files**, zero failures.
- Functions build, app TypeScript check, production web build and Android APK assembly passed.
- The replacement APK's 42 web-distribution files match the freshly built distribution, and the expected sign-in progress/retry and scene error-handling strings are present.
- APK: `deliverables/AI-SmartStick-user-scene-login-fix-2026-10-18.apk`.
- SHA-256: `2fbaa6378a6660cd83b7a57864ccb7b3d9f2f714eef0b8a69dcaec6fee50492c`.
- Installed successfully with `adb install -r` on the OnePlus CPH2573. Android reports update time 2026-10-18 07:54:41. The package is the user app in real-data mode.

The walking algorithm itself was not changed in this pass. Phone launch and manual assistant retest results are recorded in the associated `validation/scene-login-*` and `validation/scene-server-*` files.

## Installed-phone verification

The installed APK hash matches the delivered artifact exactly. The updated app restored the existing account and reached the connected-stick setup/home flow in real mode; the native background service and walking tracker reported running. No crash entries were recorded for the new app process during the observed smoke check.

A second authenticated bundled-image request, after installing the updated APK, returned HTTP 200 and a spoken result in 8.609 seconds. The real assistant subsequently established its Live connection (`getLiveToken ok`, 2.410 seconds) and entered the listening state. The user then performed the requested actual camera/voice scene check and confirmed it was working. No private camera photo or microphone recording was uploaded by the diagnostic fixture calls.
