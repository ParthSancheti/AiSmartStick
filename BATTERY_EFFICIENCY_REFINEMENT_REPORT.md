# AI SmartStick — Battery Efficiency and Walking Guidance Refinement

> GitHub publication update: matching Android/native-check sources have now been recovered from the existing repository commit `c37f442`. Read [publication notes](GITHUB_PUBLICATION_NOTES.md) and [complete setup](docs/SETUP.md) for the integrated branch. Earlier references to native source being absent describe the uploaded ZIP; APK/device validation remains unverified.

Date: 10 October 2026. Source: uploaded `smartstick.zip` (SHA-256 `49e40156b90931012effd8924c04408b404f0f6ea02172f559407d253f6f16ac`), which is newer than the earlier repository checkout. This report supersedes the previous battery-only report and includes the user's requested walking/navigation refinement.

**Implemented and software-tested:** immediate raw forward-range warnings, bounded approach estimation, camera awareness during walking/navigation, honest left/center/right observations, conservative stopped inspection candidates, navigation/audio validity and lifecycle fixes, and verified SafeMode/wake/camera ownership corrections. Existing screens and the UnifiedAudioOrchestrator remain in use.

**Hardware boundary:** the user confirmed **150 m → 140 m**, and **one forward HC-SR04 plus a monocular ESP32 camera**. That sensor arrangement cannot measure those distances, establish exact side clearance, or certify an obstacle-free bypass. The existing firmware's short-range validity checks remain unchanged. No simulated centimetre example is presented as the user's metre example working. Physical walking safety and battery-life improvement remain unverified.

## 1. Main consumption sources and defects found

- **Camera/Wi-Fi:** QVGA JPEG, quality 15, two PSRAM buffers and `CAMERA_GRAB_LATEST`; the camera driver may capture even without an HTTP consumer. Clone-camera RGB565-to-JPEG conversion allocates per frame. Streaming has one viewer on a separate HTTP task. Camera power transitions previously raced captures across cores, and waking could initialize the camera from the local safety loop.
- **Phone vision:** EfficientDet-Lite0 CPU inference and bitmap decoding are necessary during use. Previously the loop captured only when filtered front sonar was within 150 cm: active navigation and walking beyond that range received no proactive camera awareness. Restart/worker error paths could overlap work or leak bitmaps. Repeated/future frame timestamps and one awaited stream-sequence path lacked guards.
- **Evidence correctness:** empty lanes were reported `FREE`; wide objects occupied only their midpoint lane; one sonar range was attributed to a camera label; missed/stale detections retained apparent confirmation. A separate user-requested cloud scene fusion path repeated that false association. These errors could produce unsupported side-clearance advice.
- **Sensors:** existing HC-SR04 sampling is 60 ms, MPU6050/fall processing 20 ms, and INA219 measurement 500 ms. These safety-related periods remain unchanged. HTTP packet sequence identifies a request, not a new ultrasonic sample. Phone raw conditioning lacked range-rate estimation and retained valid IMU state after errors. Pipeline resets left previous conditioning behind. Delayed HTTP responses also rejuvenated old sensor data because receipt time omitted request/body/fallback duration.
- **Guidance/navigation/audio:** hazard alerts waited for camera snapshots and a shared cooldown could suppress escalation. GPS/route races could revive stopped navigation, announce turns while off route, or infer arrival from a distant endpoint projection. Detached retries and queued speech could speak obsolete directions. SafeMode suppressed motor warnings even while its local obstacle FSM ran; wake could fail to restart an unchanged warning zone.
- **Working components retained:** firmware reconnect backoff, local filtering/hysteresis/fall detection, the existing camera hub, Gemini Live session generation/idle ownership, Firebase listener teardown, authentication, SOS and the native integration interfaces. No continuous Gemini vision, new cloud service, background process or dependency was added.

## 2. Exact modified files and reasons

Paths are relative to the project root. `validation/source-changes.json` also records every delivered changed/added file with a reason and hashes.

| Authored production file | Reason |
|---|---|
| `src/core/guidance/guidanceEngine.ts` | Evaluate raw telemetry immediately, coordinate graded speech/haptics and freshness, own one lifecycle timer/subscription set, and invalidate obsolete hints and spoken facts at dequeue. |
| `src/core/guidance/guidanceState.ts` (new) | Small pure advisory and internal state shared with navigation; preserve unresolved holds, reject clock rollback and distinguish stopped inspection from physical clearance. |
| `src/core/vision/visionScheduling.ts` (new) | Capture for navigation/walking and reliable short-range approach; retain existing cadence and stationary idle behavior. |
| `src/core/vision/visionLoop.ts` | Serialize lifecycle work, use walking policy, retain pre-request sensor context, clear old snapshots and create debug image URLs only while the existing debug overlay is open. |
| `src/core/vision/framePipeline.ts` | Share pending captures; reject stale/invalid/future/repeated timestamps and reused stream sequences; keep FPS calculations finite. |
| `src/core/vision/fusionEngine.ts` | Keep undetected directions unknown, apply broad boxes to all overlapped bands, separate sonar and visual identity, and expire unreliable evidence. |
| `src/core/vision/objectTracker.ts` | Reject repeated frame confirmation, reset stale history/velocity and publish immutable snapshots. |
| `src/core/vision/spatial.ts` | Validate boxes and compute all occupied image bands without inferring world-space clearance. |
| `src/core/vision/types.ts` | Describe evidence/freshness, overlapping image bands, optional frame dimensions and pre-request pose explicitly. |
| `src/core/vision/sensorConditioning.ts` | Add bounded, sample-time-based range trend/projection, reject invalid IMU/clock rollback, exclude already aged readings and expose lifecycle reset without filtering away sudden close readings. |
| `src/core/telemetry/pipeline.ts` | Reset conditioned history, validate timing and include conservative transport age while preserving actual receipt diagnostics and firmware sample identity. |
| `src/core/telemetry/obstaclePolicy.ts` (new) | Share the unchanged existing sensitivity constants without importing device bridge/network ownership. |
| `src/core/device/deviceConfig.ts` | Re-export and consume those same constants; configuration values are unchanged. |
| `src/core/navigation/realNavigator.ts` | Guard route generations, GPS freshness, arrival and reroutes; pause published turns immediately during hazard holds; clean up subscriptions/timers. |
| `src/core/navigation/stickHaptics.ts` | Recheck route/hazard ownership for each tap, including the delayed left-turn tap. |
| `src/core/ai/voiceOut.ts` | Bound same-key retry ownership, check validity on every retry and cancel obsolete announcements. |
| `src/core/audio/audioManager.ts` | Preserve the one queue/PCM owner; discard obsolete guarded speech, avoid unchanged audio-state publications, remove temporary PCM copies and disconnect completed nodes. |
| `src/core/device/bridge.ts` | Forward optional request timing; remove duplicate obstacle speech and unsupported clear-side advice. GuidanceEngine owns the spoken complement. |
| `src/core/vision/fusion.ts` | Keep explicit cloud-photo labels separate from unidentified sonar reflections; preserve independent source timestamps. |
| `src/core/ai/executor.ts` | Label delayed scene results as earlier photos and provide honest separate evidence to the existing Live image-request path. |
| `src/core/ai/tools.ts` | Remove instructions to infer metres/steps or a safe bypass from one photo. |
| `functions/src/assistant.ts` | Correct existing vision prompts and source timing; preserve the existing Functions/Live transport. |
| `shared/assistantContract.ts` | Correct misleading evidence-association comments; wire fields remain compatible. |
| `src/features/debug/DetectionDebugView.tsx` | Add a few diagnostics to the existing overlay: trend, estimated rate/time, evidence and hold/plan; withhold unknown resolution and skip hidden visual clock updates. |
| `src/core/vision/detector.ts` | Release sender-owned bitmaps and failed-send timers; recover worker crashes/construction failures; ignore obsolete worker generations. |
| `src/core/vision/detector.worker.ts` | Close received bitmaps in `finally` on success and failure. |
| `src/core/transport/httpTransport.ts` | Share one pending physical photo; propagate request start and monotonic elapsed duration without changing the firmware JSON. |
| `src/core/transport/types.ts` | Optional internal packet timing metadata; existing two-argument consumers and synthetic mock transport remain compatible. |
| `src/core/transport/legacyTransport.ts` | Include request/body age for the existing unverified test transport and suppress JSON responses completing after disconnect; synthetic identities remain unverified. |
| `src/hooks/useGuardianVision.ts` | Release bitmaps on drawing/decode failure and ignore obsolete unmounted work. |
| `firmware/ai_smart_stick_v1/OperatingMode.h` (new) | Shared mode policy: Normal and SafeMode retain local safety; safe boot wakes without enabling its failed camera. |
| `firmware/ai_smart_stick_v1/stick_main.cpp` | Restore SafeMode warnings/fault reporting and unchanged-zone wake cues; request camera lifecycle work without blocking safety. |
| `firmware/ai_smart_stick_v1/CameraAccess.h` (new) | Nonblocking shared camera capture/power ownership with coalesced latest power request. |
| `firmware/ai_smart_stick_v1/Drivers.cpp` | Apply guarded camera lifecycle requests outside the safety loop and share ownership with frame consumers. |
| `firmware/ai_smart_stick_v1/Drivers.h` | Declare the shared guard/lifecycle interface. |
| `firmware/ai_smart_stick_v1/Api.cpp` | Use shared capture ownership for photos/streams/self-test and process camera lifecycle on the existing API HTTP task. |
| `firmware/ai_smart_stick_v1/Api.h` | Expose nonblocking camera-work service to the main loop. |
| `firmware/ai_smart_stick_v1/Ecu.h` | Consume the shared operating-mode definition. |
| `package.json` | Include the actual-control-loop host regression command in `test:firmware`; dependencies and lockfiles are unchanged. |

**Tests:** 20 new Vitest files provide 244 cases beyond the original 429 (30 earlier resource cases and 214 walking/evidence/navigation/audio/timing cases). Exact filenames and reasons are in the manifest. Two old assertions that explicitly required false camera/sonar identity were corrected in `tests/visionEngine.test.ts` and `tests/integration-contracts.test.ts`. Five existing voice mocks gained the new cancellation export, without changing assertions. Existing stream/lifecycle fixtures now supply distinct physical timestamps and valid conditioned context; original lifecycle expectations remain intact. `firmware/tests/test_safety.cpp` retains existing checks and adds guard/mode cases; new `test_control.cpp` compiles actual main source against five external hardware stubs in `firmware/tests/host/`.

**Generated Functions outputs refreshed by the existing build:** `functions/src/shared/tools.ts`, `functions/src/shared/assistantContract.ts`, `functions/lib/assistant.js`, `functions/lib/assistant.js.map`, `functions/lib/shared/tools.js`, and `functions/lib/shared/tools.js.map`. They correspond to the authored source; no deployment occurred.

**Documentation/validation:** this report, `WALKING_GUIDANCE_REFINEMENT_REPORT.md`, a README link, the changed-file manifest, counted PCM experiment/results, check-results JSON, optional browser smoke and retained test/negative-control logs. New local dependency/build caches and emulator logs are excluded from the ZIP.

## 3. Implemented refinements

The existing pull/worker architecture keeps one pending capture and one serialized inference iteration. Old or reused frames are dropped. Bitmaps and temporary URLs have explicit cleanup. Active walking/navigation now gets camera awareness before sonar proximity, including hidden-screen scheduling; steady operation retains the existing 250 ms minimum interval. No unvalidated lower adaptive frame rate was introduced.

The approach estimator keeps at most five distinct physical sample times across two seconds. It uses actual elapsed firmware time, requires at least three consistent readings spanning 500 ms for a trusted projection, and resets on stale/invalid/gap/duplicate/reboot/unstable-motion evidence. Positive closing rate describes the **forward beam range**, not an object's velocity or collision time. A two-second advisory horizon can request attention before the existing warning boundary. The newest raw close reading still raises danger without waiting for median UI filtering or inference.

HTTP sensor age now conservatively includes the entire request/body/fallback duration plus the firmware sample age. Actual arrival time remains available for link diagnostics. Device uptime and sample age retain their original meaning for range-rate estimation; the wire protocol is unchanged. Already delayed stale samples cannot establish a trusted trend or release an unresolved hold. Clock rollback invalidates old conditioned confidence and queued route permission until fresh evidence arrives.

The remaining advisory ETA also advances by that measurement age between packets, stays at or above zero and expires with stale evidence. It never updates the measured raw distance by extrapolation. Because request age is an upper bound, the ETA may request attention earlier than physical reality; it is not a collision-time measurement.

Visual objects overlap image bands rather than measured navigation lanes. Missing, tentative, stale or lost data cannot declare a side free or release an unresolved central hold. Side inspection hints require fresh usable current and pre-request pose; sweeping/rapid/stale IMU suppresses those hints while retaining warnings. MPU6050 does not establish world yaw or camera mount alignment.

Navigation stops issuing turns during a local hold, stale/inaccurate GPS, off-route movement or rerouting. The existing view displays its paused error state; release waits for fresh GPS. Speech and delayed taps recheck ownership. Same-key speech retries replace previous timers; invalid queued/current owned speech is discarded through UnifiedAudioOrchestrator, preserving the active conversation/PCM ownership.

Queued guidance also rechecks the specific fact it would speak: approach versus receding range, measured-close versus latched MCU warning, and visual versus forward-sensor evidence. Sensor/frame expiry is checked at speech dequeue between lifecycle ticks. A latched motor danger still warrants stopping; it does not prove the newest measured range is very close. Ordinary fresh range changes within the same danger zone do not cancel valid advice.

The local obstacle plan is `OBSERVE`, `SLOW_AND_CHECK`, `STOP_AND_SCAN` or `SENSING_UNAVAILABLE`. Candidate sides mean **inspect with the cane while stopped**. The existing Maps/OSM route still supplies global walking directions and real GPS off-route rerouting. No false camera-generated metric bypass or unsupported obstacle-exclusion route was added.

## 4. Preserved safety behavior and existing features

Firmware obstacle/fall/motor decisions remain local and independent of Gemini, Firebase, the phone and internet. Existing medium boundaries 150/100/50 cm, sensitivity presets, 15 cm hysteresis, confirmation/filtering, 500 ms firmware sensor staleness and 60/20/500 ms sensor periods remain unchanged. SafeMode/wake fixes correct demonstrable output bugs rather than speculate about thresholds. Camera lifecycle has no new task or sleep feature.

Explicit Sleep retains its pre-existing ultrasonic/motor suspension; automatic sleep defaults off. These changes do not certify sleeping assistive operation. No deep sleep, Wi-Fi power-save, JPEG/buffer retuning, new background service or new dependency was enabled.

SOS, fall logic, authentication, Firebase, navigation, device communication and Gemini Live regression suites pass. Live WebSocket/native interfaces and the existing single audio system remain in use. User-requested cloud photos remain available; autonomous local walking guidance sends no camera frames to Gemini. Native Android source is absent from the upload, so Android PCM, screen-off foreground-service operation and APK behavior remain unverified here.

## 5. Measurements, tests, estimates and hardware-only metrics

### Measured before versus after — controlled host fixtures

| Observable fixture | Uploaded source | Refined source |
|---|---:|---:|
| Physical photo adapter calls for 20 concurrent consumers | 20 | 1 |
| Pending capture calls across a reset fixture | 2 | 1 |
| Worker inference-failure bitmap close calls | 0 | 1 |
| Transfer-failure bitmap close calls | 0 | 1 |
| Debug URLs created after a stop callback | 1 | 0 |
| Last debug URL explicitly revoked on stop | 0 | 1 |
| Temporary PCM allocation over 1,000 completed chunks | 9,600,000 bytes | 0 bytes |
| PCM sample copies over those chunks | 2,400,000 | 0 |
| Playback storage over those chunks | 9,600,000 bytes | 9,600,000 bytes |
| Explicit completed-source disconnect calls | 0 | 1,000 |
| New walking-evidence scenarios run against each source | 0 pass / 26 fail | 26 pass / 0 fail |
| Actual-main host control regression scenarios | 27 pass / 18 fail | 45 pass / 0 fail |

The PCM experiment counts cumulative temporary allocations with mocked Web Audio for 100 ms mono 24 kHz chunks; it does not measure peak RSS, CPU, energy or browser battery. Reproduce with `node validation/pcm-allocation-check.mjs <original-root> <refined-root>`. Main-control baseline uses original source with external hardware stubs and legacy API adapters; 11 baseline failures are behavioral and seven are source contracts. Negative-control failures are intentional new regression evidence, **not original-suite failures**.

Follow-up speech controls were captured against the earlier refined engine: seven factual-validity cases failed in a 20-case runtime run before the dequeue guard; one far-range latched-danger wording case failed in the subsequent 21-case run before its wording correction. The fixed engine passed 73 targeted cases across four suites. Logs are retained under `validation/guidance-*.log`. These are observed software regressions, not physical before/after latency measurements. No pre-fix timing-control baseline was captured, so none is claimed.

### Automated results and synthetic examples

Original existing suite: 429/429. Final app suite: **673/673 in 62 files**. Firmware host: **64 logic/guard + 45 actual-control checks**. Rules: **15/15**. Under controlled clocks, navigation captures four frames at 0/250/500/750 ms and slow inference does not accumulate jobs. This establishes steady scheduling, not measured phone FPS; immediate lifecycle restarts can reset cadence.

Synthetic 150→140→130 **cm** at 500 ms spacing yields 20 cm/s and 1.5 s to the existing 100 cm warning boundary. Synthetic 400→300→200 cm triggers look-ahead before the awareness boundary. A raw sudden 20 cm reading raises danger even when the existing median UI remains 250 cm. These are arithmetic/regression fixtures; they do not demonstrate the requested 150→140 **metres** scenario.

A deterministic HTTP fixture with 1,600 ms request/body delay and 40 ms firmware sample age produces 1,640 ms sonar age and stale evidence; a 250 ms delay produces 290 ms age and remains valid. A fresh scene cannot make delayed sonar current. These values validate bookkeeping under controlled clocks; they are not observed Wi-Fi latency on a real stick.

In another controlled fixture, a trusted 400 cm sample closing at 100 cm/s projects three seconds to the 100 cm warning boundary at measurement time; after 1,200 ms of valid conservative age, the remaining advisory estimate becomes 1,800 ms and requests attention through the existing two-second horizon. Raw range stays 400 cm. This tests arithmetic and freshness, not real object velocity or safe walking clearance.

### Estimated improvements

Shared requests, cleanup and removal of unnecessary PCM copies eliminate exercised wasted work. No battery percentage, runtime extension, physical latency improvement or CPU saving is estimated. Walking camera awareness now performs **more necessary work** than the previous proximity-only loop; actual battery consumption could increase during navigation.

### Metrics requiring physical hardware

Camera exposure/capture FPS, actual inference FPS/latency, physical obstacle-to-alert/motor latency, stale/dropped frame distribution, ESP32 reconnections and Wi-Fi airtime, Android CPU/RSS/thermal behavior, and calibrated INA219 energy remain unmeasured. Request-start/live-arrival timestamps are software proxies for frame age, not sensor exposure timestamps.

## 6. Build, type-check and tests

| Command/check | Final result |
|---|---|
| Frozen root and Functions dependency installation | Previously passed with existing lockfiles; Node 22.23.3 |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; existing bundle/dynamic-import warnings |
| `npm run build:demo` | Passed |
| `npm run functions:build` | Passed |
| `npm test` | 673 passed, 0 failed, 62 files |
| `npm run test:firmware` | 64 + 45 passed, 0 failed |
| Additional pure firmware compile under C++11 | 64 passed |
| Firestore emulator rules | 15 passed; emulator shut down normally |
| Production-built demo browser smoke | Existing onboarding/demo/debug controls rendered and closed; 0 JavaScript page errors |
| Native Android build/typecheck | Unavailable: upload lacks `android/` and `android-typecheck/` |
| ESP32 target build/flash | Unverified: required authoritative Arduino/core downloads return proxy HTTP 403; no board connected |

Rules command: `firebase emulators:exec --project demo-aiss --only firestore 'npm exec -- vitest run -c vitest.rules.config.ts'` with Firebase CLI 15.33.0 and Java 21. No existing-suite failure remains in the final checks. Transitional failures from missing mock exports or same-clock fake frames were corrected through dependency/physical-time fixtures; safety assertions were not weakened to pass.

## 7. Remaining hardware validation

Use supervised trials with a sighted tester and physical protection before assistive walking use. Measure unexpected central obstacles, wide left/right obstructions, crossing people, sweeping the stick, orientation changes, angled/soft/transparent surfaces, no echo, disconnected sensors, poor lighting, camera contention, stale GPS, stop/start, explicit Sleep/SafeMode/wake, offline operation, fall/SOS and concurrent Live speech. Include screen-off navigation on the matching native Android build. Existing object detection does not establish terrain, drop-off, curb, head-height or road-crossing safety.

Confirm camera mounting/image coordinates, sensor beam geometry and INA219 calibration/polarity. Use equal-duration before/after runs on the same board/phone/battery/brightness/radio conditions. Log existing debug/trace FPS, latencies and drop counts, approach reset/confidence and hold/plan; collect adb/Perfetto CPU/memory/thermal and Android battery data separately. Integrate actual stick readings as `sum(voltage_V * discharge_current_mA * seconds / 3600)` for mWh, tracking missing samples. Displayed stick percent remains an estimate; phone battery stays separate. No additional telemetry service was added.

## 8. Trade-offs and risks

- Walking vision uses more camera/CPU/radio activity than the old proximity-only trigger. It is required for the requested awareness; battery improvement is unverified.
- Advisory trend can reflect changing surfaces or user movement; consistency confidence is not physical certainty. Side hints remain camera-relative, with no measured human-width corridor or bypass distance.
- Conservative holds may persist through no echo, camera failure or lost central tracks. This reduces unsupported turns but can delay navigation; a fresh greater forward range and fresh resolved scene are needed to release a prior hold.
- Charging the full HTTP duration is deliberately conservative because response generation time is unknown; a slow link can pause phone directions even when a response was generated late in the request. Independent local motor warnings remain active.
- Visual tracks require confirmation again after a >1500 ms gap. Local raw warnings and ECU logic do not wait for this confirmation.
- Shared photos inherit the first consumer's timeout/frame/error; restarted vision waits for outstanding work. Camera power requests wait for capture release and existing API work scheduling. Hardware must validate these timing/driver paths.
- Target firmware compilation, native PCM/service behavior, actual detection quality and physical safety remain unverified. Passing host tests is not certification.

## 9. Three necessary next priorities

1. Run supervised board/phone validation of warnings, mode/camera contention, navigation hold/resume, frame latency and matched INA219/Android energy before real assistive deployment.
2. If exact side clearance or 150 m distance tracking is mandatory, provide calibrated directional depth/ranging hardware and validate its coverage; the confirmed single beam/camera cannot meet that requirement through software alone.
3. Build and test with the matching native Android project and ESP32 toolchain, especially screen-off continuity, SOS, native Live/audio interruption and actual driver timing.
