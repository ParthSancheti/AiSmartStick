# Walking algorithm refinement — 18 October 2026

The walking decision system is now extracted into a deterministic, device-independent TypeScript core and a single JavaScript module with **zero runtime imports**. The production app and offline replay use the same decision reducer. This pass changes sensing, tracking, evidence handling and spoken guidance; the crafted UI is retained.

## What changed

| Layer | Implemented behavior |
|---|---|
| Sensor conditioning | Independent instances, explicit caller-supplied time, generic structural observations, valid time zero, clock/future-time rejection, raw near ranges preserved immediately. Runtime clock access is confined to a small adapter. |
| Visual tracking | Visible-image box clipping, malformed/zero-confidence evidence rejection, duplicate detection suppression, strongest-overlap association across candidates, independent published snapshots, motion history reset after misses, gaps or edge clipping. |
| Image motion | Bounded multi-frame box expansion diagnostics. Camera movement and object movement are not separable from these boxes alone; no metric depth, object speed or collision time is invented. |
| Fusion | Freshness is checked inside fusion itself. Sonar stays an independent forward-beam measurement; its distance is never attached to an arbitrary detected object. Unobserved image bands remain `UNKNOWN`. |
| Obstacle hold | Valid close range escalates immediately. A previously held route needs distinct fresh range samples and camera frames, usable compatible pose, time and range hysteresis before route cues resume. |
| Speech | Movement-aware speech policy is portable. Camera descriptions are camera-relative. Camera-derived physical left/right cane instructions are removed; queued directional descriptions are rechecked against current evidence. |
| Inspection | Real footage is run through the existing detector and the production core. Annotated videos and JSON show tracks, uncertainty, plans, reasons and sensor provenance. |

The pure entry point is `src/core/perception/index.ts`. Its modules use no stores, UI framework, phone plugins, network, system clock or timers. The application retains thin adapters for actual input and effects. The JavaScript bundle also runs with `Date.now` and `fetch` deliberately disabled during the standalone smoke test.

## Concrete old-versus-new result

The comparison uses the preserved source ZIP from immediately before this pass, rather than an older Git revision. After a 20 cm obstacle hold, the previous algorithm released on one farther range plus an empty frame. It also released during a stick sweep, a 90-degree pitch, nonfinite pose, capture/current pose disagreement, capture-pose timing mismatch, poor camera quality, and duplicate-only evidence ticks.

All **eight premature-release counterexamples** remain held with the refined core. Fresh no-return evidence keeps a previous hazard held in both versions. With a sustained valid recovery sequence sampled every 250 ms, route-cue eligibility resumes after **750 ms of corroboration**, compared with immediate release in the old implementation. This is a software behavior test, not a stopping-distance or clearance measurement.

Current release policy: at least three distinct range samples and two distinct camera frames, at least 700 ms of corroboration, and measured range at least 10 cm beyond the configured warning boundary. Camera/pose/range age budgets are 1500 ms. Tilt (35 degrees), capture/current pose change (15 degrees), angular-rate and timing limits are conservative software proxies. They require calibration and validation with the finished mounting; they do not measure yaw or establish body/world alignment.

The original machine-readable evidence was recorded as `validation/algorithm-before-after.json` and is retained in the private local cleanup backup. The obsolete external-baseline comparison tool was archived with it; current core regressions remain in `tests/walkingCore.test.ts` and `tests/walkingAdversarialReplay.test.ts`.

## Actual video experiment

Downloaded [Spiegelgasse, Zurich, by Albinfo](https://commons.wikimedia.org/wiki/File:Spiegelgasse.ogv), published under CC0. It is actual first-person walking footage, including narrow passages, pedestrians, parked cars, a fountain and café furniture.

- Ran the existing EfficientDet-Lite0 asset with the app's IMAGE/CPU settings, score threshold 0.35 and maximum 12 detections.
- Processed **360 real frames across two excerpts totaling 90 seconds**, at four samples per second, producing **537 detector observations**.
- Python MediaPipe 1.1.1 is used offline; the app's JavaScript runtime is 1.1.0. Matching model and settings do not imply bit-identical runtime output.
- Real-video replay has no recorded sonar, IMU, GPS or calibrated camera/body relationship. Those channels remain unknown. Consequently, an obstacle hold cannot be fully resolved from this video alone.
- A separate video uses the same real camera observations with **explicitly SIMULATED** range/motion traces: approach, sudden 20 cm range, sweeping/no echo, farther range while sweeping, recovery, outage and restoration. These sensors are independent injected test stimuli, not measurements from the walk.
- The actual and injected replays make **zero `FREE` path claims** and assign **zero invented object distances**.

Desktop detector median/p95 latency was 31.73/46.79 ms on the first excerpt and 25.99/43.85 ms on the second. Replay uses a logical capture clock and records desktop inference latency separately. These are not phone, network, end-to-end response-time or battery measurements. Videos are silent 4 FPS sampled analysis replays.

Manual review found a persistent building-as-`train` error, missed foreground chairs at 115 seconds, and missing terrain/step representations around the fountain. Tracking helps temporal consistency but cannot correct repeated semantic errors or discover obstacles outside the detector's coverage. See [the video review](ALGORITHM_VIDEO_REVIEW.md) for inspected examples and reproduction commands.

## Verification and artifacts

At the end of the algorithm pass, the app suite passed **917 tests across 79 files**, and the user app production build passed. Later scene/sign-in fixes increased the suite to **955 tests across 80 files**; see [the current verification record](VERIFICATION.md). The separately copied portable TypeScript source also compiled with only the ES2022 standard library, without DOM or app types. The standalone example and disabled-clock/network smoke test passed.

The automated fault replay passed **20,000 events and 155,268 assertions** across four fixed seeds. It includes 728 immediate raw-danger checks, 697 held no-return cases, 611 duplicate-only held cases, 2,593 invalid-pose held cases and 109 verified recoveries. It exercises production tracking, fusion, normalization and decision logic, including state serialization and mutation isolation. These are synthetic software tests, not physical trials.

Source is maintained in `src/core/perception/`, with the shared tracking/fusion and speech modules under `src/core/vision/` and `src/core/guidance/`. Run `npm run algorithm:build` to produce `deliverables/algorithm-replay/core/walking-core.mjs`, then `npm run algorithm:smoke` to exercise it without app, clock or network capabilities. The original generated evidence pack and raw validation outputs were moved to the local backup during [cleanup](CLEANUP.md). Replay commands regenerate fresh artifacts from the attributed source video; generated files are intentionally ignored by Git.

## Remaining algorithm work established by the experiment

The current detector is not a traversability or depth model. A reliable AR-like local scene needs calibrated camera mounting and timing, terrain/obstacle coverage for curbs, stairs, drop-offs, narrow poles and overhead hazards, and a labeled evaluation set representative of the actual stick. A single beam plus monocular object boxes cannot supply a validated 3D occupancy map or body clearance. Persistent wrong labels, low light, blur and same-class crossing identity remain unresolved by this pass.

User walking speed, forward-beam closing rate and image-box motion remain separate quantities. Fresh speed evidence affects speech cadence; range trend provides an advisory time to the configured warning distance. Neither is treated as object collision time, and arbitrary speed-based stopping distances are not introduced without measurements and calibration.

The implementation is materially stronger and reproducible, with its remaining limitations exposed in the replay. Finished-hardware and supervised field validation are still required before making reliability or autonomy claims.
