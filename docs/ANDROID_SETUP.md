# Android setup

Follow [build guide steps 2, 4 and 5](BUILD_GUIDE.md) for current prerequisites, Firebase configuration and APK installation. Use **JDK 21, SDK 36 and Node 22.12+**, and preserve the existing custom Android project.

Build sequentially with `npm run apk:user`, then `npm run apk:guardian`. The fixed packages are `in.aismartstick.app` and `in.aismartstick.guardian`. Each build validates its matching real-mode web bundle; changing only a Gradle property is insufficient.

See [dual-app configuration](DUAL_APP_SETUP.md) for certificate/Firebase files and [acceptance checks](REAL_DEVICE_ACCEPTANCE.md). Keep signing keys and native Firebase configuration private.
