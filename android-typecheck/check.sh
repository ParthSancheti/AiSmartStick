#!/usr/bin/env bash
# Type-checks the app's native Java (AissNativePlugin, StickForegroundService, MainActivity) against
# the real Android API surface (android.jar, API 30 mirror) with small Capacitor/AndroidX stubs.
# This is NOT a Gradle build; it catches Android API/signature mistakes when no SDK is installed.
set -euo pipefail
cd "$(dirname "$0")"
[ -f android.jar ] || curl -sL -o android.jar https://raw.githubusercontent.com/Sable/android-platforms/master/android-30/android.jar
rm -rf out && mkdir out
javac -Xlint:all -Xlint:-options -d out -cp android.jar -sourcepath stubs $(find stubs -name '*.java') ../android/app/src/main/java/in/aismartstick/app/*.java
echo "Native Java type-check OK"
