# AI SmartStick — documented prototype build

Source, original NX 10/STL enclosure files, renders, wiring and a beginner rebuild guide are included in the source archive.

- `AI-SmartStick-user.apk`: user app, package `in.aismartstick.app`.
- `SmartStick-Guardian.apk`: separate Guardian app, package `in.aismartstick.guardian`.
- `SHA256SUMS.txt`: SHA-256 checksums for both APKs.

Both are debug testing builds in real-data mode, using the maintainer's configured backend. Independent builders must configure their own Firebase/Google Cloud project and signing certificates. Use separate user and Guardian accounts.

Includes device-independent walking logic, improved evidence freshness/recovery, native walking persistence, coordinated navigation/audio, the scene-service timeout/configuration fix, and Google sign-in progress/single-flight handling. Recorded validation is 955 app tests; fault replay covered 20,000 events and 155,268 assertions.

This is a prototype for supervised trials. Recognition can miss or mislabel objects; mount calibration, electrical power/driver verification, terrain/drop-off coverage and real-world reliability remain to be validated. CAD units, print settings and several component ratings are unconfirmed. Follow the README and build guide before assembly.
