# Verification record

## Recorded checks — 18 October 2026

The latest scene-analysis and sign-in fix passed **955 app tests across 80 test files, with zero failures**. The recorded Functions build, TypeScript check, production web build and user Android APK assembly also passed. The installed user APK restored its existing account, launched in real mode, and the owner confirmed that the actual assistant scene request worked after installation. See [the fix details](SCENE_AND_LOGIN_FIX.md).

The walking-core fault-injection run passed **20,000 seeded synthetic events and 155,268 invariant assertions**. It checked immediate raw-range danger, retained holds during missing/duplicate/stale evidence, unusable pose, independent evidence on release, deterministic replay and immutable prior state. The same source is used by the app and the portable build. These figures describe software evidence, not physical obstacle-detection accuracy.

Real walking footage was processed with the local model and reviewed manually. It exposed missed foreground furniture, incorrect persistent labels and absent terrain/step representations. [The video review](ALGORITHM_VIDEO_REVIEW.md) gives the source, exact settings, observed failures and reproduction commands. Detector output was not treated as ground truth.

Raw phone/cloud logs and screenshots are private local evidence and were archived during repository cleanup. Their filenames appearing in historical reports identify local records, not downloadable repository files. Test summaries above were retained from those records before archiving.

## Reproduce the software checks

After following the [setup guide](SETUP.md):

```powershell
npm ci
npm run typecheck
npm test
npm run build:user
npm run build:guardian
npm run algorithm:build
npm run algorithm:smoke
npm run test:walking-native
npm --prefix functions ci
npm run functions:build
```

The native walking check requires a JDK. Firmware host checks and Firestore emulator checks have separate compiler/Java requirements documented in the firmware and cloud guides. APK builds use `npm run apk:user` and `npm run apk:guardian` sequentially, after each app's Firebase configuration has been supplied.

These checks do not certify obstacle coverage, metric depth from images, stair/drop-off detection, finished-mount calibration, battery runtime or real-world navigation safety. Complete the supervised [real-device acceptance plan](REAL_DEVICE_ACCEPTANCE.md) before relying on the device in daily use.
