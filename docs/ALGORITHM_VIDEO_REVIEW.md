# Actual walking-video review — 18 October 2026

This is a qualitative inspection of real video and actual local model output. It is **not** a labeled accuracy benchmark, a physical navigation trial, a depth evaluation, or a collision-avoidance certification. The detector's own outputs are not ground truth.

The original generated videos, contact sheets and raw JSON records were archived during [repository cleanup](CLEANUP.md). Paths below identify reproducible local outputs, rather than committed downloads. Use the commands in this guide to generate a new run.

## Source and reproducibility

- Video: [Spiegelgasse, Zurich, by Albinfo](https://commons.wikimedia.org/wiki/File:Spiegelgasse.ogv), self-published under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The silent original depicts a handheld first-person walk through narrow streets and a courtyard.
- Original download: `https://upload.wikimedia.org/wikipedia/commons/5/56/Spiegelgasse.ogv`.
- Source SHA-256: `db2d5ac45b7ecadb99dd3e84366817dca7c56ee30968b31aece7d8c3740d04d0`.
- Model: the app's `public/models/efficientdet_lite0.tflite`, SHA-256 `0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb`.
- Inference: MediaPipe Python 1.1.1, CPU, IMAGE mode, score threshold 0.35, maximum 12 results. This matches the app's model asset and detector settings; the app uses the JavaScript runtime, so bit-identical cross-runtime output is not asserted.
- Samples: 0–59.75 seconds at 4 FPS (240 frames, 387 observations), and 90–119.75 seconds at 4 FPS (120 frames, 150 observations).
- Desktop CPU inference median / p95: 31.73 / 46.79 ms for the first excerpt; 25.99 / 43.85 ms for the second. These values exclude phone/network/firmware behavior and do not measure exposure-to-guidance latency.
- Source contact sheet: `validation/algorithm-video-source-contact-sheet.jpg`.
- Actual detection contact sheet: `validation/algorithm-video-detection-contact-sheet.jpg`.
- Machine-readable observations: `validation/algorithm-video-detections.json` and `validation/algorithm-video-crowd-detections.json`.

The source has no recorded sonar, IMU, GPS, mounting calibration, or world/body-relative camera heading. Those channels remain unknown in the real-video replay. The separately marked simulated replay supplies synthetic test inputs to exercise state transitions; those values are not measurements from the walk.

## Manually inspected examples

| Source time | Visible scene and actual model output | Consequence for the algorithm |
|---|---|---|
| 0.00 s | A person in the entrance is detected as `person` at 0.64. The facade and foreground architecture are not represented as objects. | A detected noun is useful scene evidence, not a complete obstacle inventory. |
| 15.00 s | The close woman is detected as `person` at 0.55, her bag as `handbag` at 0.61, and two small background people at approximately 0.36. | Multiple boxes may describe parts of one physical situation. They do not provide independent metric ranges, body clearance, or a certified bypass. |
| 30.00 s | Two cars and two people are returned. The large stone fountain/steps in the courtyard are visibly present without a corresponding terrain/step observation. | Recognizing pedestrians and cars does not establish ground traversability. Undetected terrain stays unknown. |
| 45.00 s | No observations are returned, while the image contains a narrow passage, walls, cobblestones and a bicycle near the right edge. | Empty detections must not mean an empty or traversable path. The edge bicycle is an apparent missed object in this sampled frame; no exhaustive annotation was performed. |
| 95–110 s | The detector repeatedly calls a large building/wall region a `train`. At 110.00 s its score is approximately 0.48. The reviewed source contains a narrow street rather than a visible train. | This is a persistent semantic misclassification, not just a transient frame flicker. A two-frame tracker cannot correct an incorrect label that repeats. A physical wall may still be an obstacle, so label error and obstacle error are distinct. |
| 115.00 s | The detector returns `umbrella` at approximately 0.45 and `bicycle` at approximately 0.39. Several obvious close chairs/tables in the foreground have no chair/table observation in that sample. | A low-confidence object vocabulary can miss relevant near-field obstacles. Sonar remains a separate channel, and unobserved lanes cannot be called free. |
| 117.00 s | Chair/table labels appear alongside umbrellas, bicycles and a distant person. | Recognition changes with viewpoint. Stable temporal evidence helps bound decisions but cannot guarantee all obstacles were detected. |
| 119.00 s | During a blurred/turned view, a chair is detected at approximately 0.57 and a facade region receives `vase` at approximately 0.36. | Camera motion can change identity/coverage. With no recorded IMU, the replay cannot claim camera-direction reliability. |

These examples are intentionally qualitative. No precision/recall, mAP, collision rate, physical range error, or false-alert rate is inferred from them.

## What the refinements can and cannot establish

The production reducer can reject stale/replayed evidence, preserve a stop across camera swings and sensing gaps, require sustained distinct corroboration before releasing a previous hold, and explain why a cue is withheld. The tracker can reduce assignment-order artifacts and expose image expansion with its provenance. Neither mechanism repairs a persistently wrong object label or supplies missing terrain measurements.

Image expansion is an image-space diagnostic. Ego-motion, panning, viewpoint change, object motion and partial occlusion can all change a box. It is not object speed, metric depth, collision time, or proof that a path is safe. A camera-relative left/right band is not a body/world heading. GPS user speed is separate from sonar range-rate.

Real-video replay should therefore show actual boxes/track IDs, fresh/lost/tentative evidence, explicit unknown sensor channels, the production plan/hold reason, and sampled frame timing. Unknown bands remain unknown. The renderer preserves the source aspect ratio so overlays do not drift into letterbox margins.

The remaining engineering work is a labeled set representative of the actual stick mounting, low-light/blur/occlusion evaluation, and supervised assembled-hardware trials. Drop-offs, stairs/curbs, thin poles, head-height hazards, surface condition and road-crossing safety are not established by this footage or the current single forward beam.

## Commands

Use an isolated Python environment with `mediapipe`, `opencv-python-headless`, and `Pillow`; H.264 rendering additionally requires ffmpeg. No Python dependency is added to the app.

```powershell
python scripts/analyze-walking-video.py contact-sheet --video .build-tmp/algorithm-replay/Spiegelgasse.ogv --output validation/algorithm-video-source-contact-sheet.jpg
python scripts/analyze-walking-video.py infer --video .build-tmp/algorithm-replay/Spiegelgasse.ogv --output validation/algorithm-video-detections.json --duration 60 --fps 4
python scripts/analyze-walking-video.py infer --video .build-tmp/algorithm-replay/Spiegelgasse.ogv --output validation/algorithm-video-crowd-detections.json --start 90 --duration 30 --fps 4
python scripts/analyze-walking-video.py contact-sheet --video .build-tmp/algorithm-replay/Spiegelgasse.ogv --output validation/algorithm-video-detection-contact-sheet.jpg --times 0,15,30,45,110,115,117,119 --detections validation/algorithm-video-detections.json validation/algorithm-video-crowd-detections.json
```

Build the portable production core and generate decisions with the JavaScript replay runner:

```powershell
node scripts/build-walking-core.mjs
node scripts/replay-walking.mjs --detections validation/algorithm-video-detections.json --output validation/algorithm-video-decisions.json
node scripts/replay-walking.mjs --detections validation/algorithm-video-detections.json --output validation/algorithm-video-injected-decisions.json --scenario injected-sensors
node scripts/replay-walking.mjs --detections validation/algorithm-video-crowd-detections.json --output validation/algorithm-video-crowd-decisions.json
```

Then render the actual-video and explicitly simulated-input replays:

```powershell
python scripts/analyze-walking-video.py render --video .build-tmp/algorithm-replay/Spiegelgasse.ogv --detections validation/algorithm-video-detections.json --decisions validation/algorithm-video-decisions.json --output deliverables/algorithm-replay/real-walk-analysis.mp4
python scripts/analyze-walking-video.py render --video .build-tmp/algorithm-replay/Spiegelgasse.ogv --detections validation/algorithm-video-detections.json --decisions validation/algorithm-video-injected-decisions.json --output deliverables/algorithm-replay/simulated-sensors.mp4 --contact-times 0,8,12,16,17.75,24
python scripts/analyze-walking-video.py render --video .build-tmp/algorithm-replay/Spiegelgasse.ogv --detections validation/algorithm-video-crowd-detections.json --decisions validation/algorithm-video-crowd-decisions.json --output deliverables/algorithm-replay/crowd-furniture-analysis.mp4
```

The videos are silent sampled replays at 4 FPS, with analysis overlays added. The modified clips retain source attribution in the video and JSON metadata.

The simulated contact sheet selects replay times 0, 8, 12, 16, 17.75 and 24 seconds to expose the sudden 20 cm input, sweep, farther range during a sweep, recovery attempt and sensing outage. A stale synthetic range is shown as **UNKNOWN** for the current measurement; a retained last value is explicitly labeled stale in diagnostics.
