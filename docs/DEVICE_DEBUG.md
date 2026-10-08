# Real-device test & debug guide (round 4)

## What was wrong

Your stick was fine. It sent correct data the whole time. The bug was one line in the app, in src/core/transport/httpTransport.ts: it loaded the Android plugin with `import(...).then((m) => m.AissNative)`. A Capacitor plugin treats every name as a native method, even `.then`. Because of that, the Promise never finished, and Home's live link waited forever before it sent its first request. Setup reaches the plugin by a different, direct path, so all four setup steps passed. After that, Home stayed on "Connecting…", and it did the same on every app start. A new test that uses the real Capacitor code (tests/stick-e2e.test.ts) showed exactly your problem before the fix ("link=connecting, provisioning=completed"). It passes now.

## Camera fix (round 5, firmware 1.2.1)

Your log showed two problems:
- "JPEG format is not supported on this sensor". Your ESP32-CAM is a clone. Its camera chip is not an OV2640, so it cannot make JPEG by itself.
- "frame buffer malloc failed". The backup setting (RGB565) asked for the 150 KB picture memory in the small internal RAM. That memory is too small for it.

What the firmware does now (same idea as your old sketch_sep19b):
- The camera starts first, before Wi-Fi and the sensors, while memory is still free.
- It always starts in RGB565, 320x240, 10 MHz, 1 buffer. The buffer goes in PSRAM.
- Without PSRAM it tries 160x120 and then 96x96 in internal RAM.
- Each frame becomes a JPEG on the stick (frame2jpg), for /api/v1/capture and :81/stream. Without PSRAM it uses a converter that needs little memory.
- Only a real OV2640/OV3660/OV5640 is switched to sensor JPEG.

How to check:
1. Arduino IDE → Tools → Board: "AI Thinker ESP32-CAM". If your board menu has "PSRAM", set it to Enabled. Partition scheme: "Huge APP" (or the default). Flash.
2. In Serial Monitor (115200), right after boot you must see:
   - `[camera] psram=yes heap=… largest=…`
   - `[camera] try RGB565 320x240 in PSRAM: ok (0x0)`
   - `[camera] init ok sensor PID=0x… format=RGB565->JPEG`
   - `[boot] … fw 1.2.1 …`
3. Join the phone or a laptop to the SmartStick_AI Wi-Fi. Open `http://192.168.4.1:81/stream` in Chrome: you must see live video. `http://192.168.4.1/api/v1/capture` must show one picture.
4. If it still fails, send me every `[camera]` line. `psram=NO` means the board setting is wrong, or the board has no PSRAM.

These lines are harmless and can be ignored: "No core dump partition found" and "GPIO isr service already installed".

## Test on the phone

1. Prepare on the PC: run `npm run doctor:fix`, then `npm run apk:install` (phone on USB). Run `cd functions && npm run build && firebase deploy --only functions`. Flash firmware 1.2.1 with Arduino IDE and open Serial Monitor at 115200 baud. Keep mobile data ON on the phone.
2. Setup: if the stick is already saved, forget it first (Settings → Stick & hardware → Forget). Run stick setup. If Android shows a 'Connect to device' box, allow it. All four steps must turn green.
3. Home connected: within about 10 s the stick card must show connected with real live numbers: battery, distance and zone. Move your hand in front of the distance sensor; the number must change. Serial Monitor must show '[HTTP] GET /api/v1/telemetry 200 …' lines.
4. Restart: close the app fully and open it again. Home must reconnect by itself, without setup. Then turn the stick off for 10 s and on again. The status must say what it is doing (it must not stay on a silent 'Connecting') and connect again.
5. Diagnostics: Home → tap the stick picture → Diagnostics → Connection test. Every step should say PASS, and 'Which way reaches the stick' must show at least one working path. Tap 'Copy report' once to check that copying works.
6. Location: Map → 'Test location' → 'Get position', near a window. A position must come within about 30 s with accuracy, and the map must show where you are. If it says Approximate, tap 'Use precise'.
7. SOS: set your own second phone as the safety number. Start a test SOS. The SMS must arrive with a https://maps.google.com/?q=… link and '(accuracy N m, …)'. Tap the link; Google Maps must open at the right place. Test again with phone location turned off: the SMS must still arrive and say 'Location unavailable'.
8. AI: say 'take me to the nearest hospital' or 'set destination to <a place>'. The AI must set it and start directions, or say they start automatically when GPS is ready, and then start them. It must never say 'maps location is unavailable'. Try once in voice mode and once in text chat.
9. Map search: type 'hospital'. A list must show. Tap a result, or press Enter on the keyboard; the walking route must start. 'End route' must stop it.
10. Profile photo: open the app once while online. Close it fully, turn on airplane mode and open it again. Your photo must show at once, never '?'.
11. Home look: check that the stick picture is bigger, the card is a bit taller, the Stick/Battery/Phone tiles are narrower with icons, and the Audio output, Distance walked and Assistant chat rows have more space. Also try with a large system font: no word should break letter by letter.
12. Demo mode: open the app with ?mode=demo (or switch to demo). It must still work as before.

## If something fails, send me these

1. Connection test report: Home → tap the stick picture (Stick diagnostics) → Diagnostics → Connection test. Wait until all steps finish, tap 'Copy report' and paste the whole text. You can also open it from Settings → Stick & hardware → Diagnostics → Connection test.
2. Location test report: Map → 'Test location' (or Diagnostics → Location test). Tap 'Get position', wait 10 s, tap 'Copy report' and paste it.
3. Phone log: connect the phone by USB and run `npm run logcat` in the project folder. Open the app, stay on Home for 30 s, then on Map for 30 s. Copy every line with [SMARTSTICK] or [LOCATION], lines with the tags AissNative, AissLocation or AndroidRuntime, and all red '!' lines.
4. Stick log: Arduino IDE → Serial Monitor at 115200 baud, for 30 s while the app is on Home. Copy every line that starts with [boot], [dashcam], [WIFI], [HTTP], [TELEMETRY], [camera] or [stream].
5. Exact texts: the red text under the map search box, the SMS text the receiver got, and what the AI answered to 'take me to X'.
6. Phone model, Android version, whether mobile data was on, and whether Android showed a 'Connect to device' box.

## Prompt for your AI IDE (Antigravity)

```
You are helping me with the AI SmartStick project (folder: aismartstick). I use Windows, Android Studio, Arduino IDE and this AI IDE. My English is simple. Please use short sentences.

PROJECT
- App: React + Vite + TypeScript + zustand inside Capacitor 8 (Android WebView).
- Native plugins: android/app/src/main/java/in/aismartstick/app/AissNativePlugin.java (joins the stick Wi-Fi and makes HTTP requests through that network; also SMS) and AissLocationPlugin.java (LocationManager GPS).
- Firebase Auth, Firestore and Cloud Functions (folder functions/).
- Stick: ESP32-CAM. Firmware: firmware/ai_smart_stick_v1, Arduino-ESP32 core 2.0.x, version 1.2.1. Camera: clone sensor without JPEG, so RGB565 + frame2jpg (Drivers.cpp camera::begin / toJpeg).
- The stick is ALWAYS its own Wi-Fi access point: SSID "SmartStick_AI", password "Stick@1234", IP 192.168.4.1. No auth (REQUIRE_AUTH 0).
- Stick endpoints, port 80:
  - GET http://192.168.4.1/api/v1/device: JSON, who the stick is (fw 1.2.1).
  - GET /api/v1/telemetry: JSON sensor packet. These are the Home numbers: battery, distance, zone, pitch.
  - GET /api/v1/status and GET /api/v1/config: JSON.
  - GET /api/v1/capture: one camera JPEG.
  - POST /api/v1/command: commands.
  - GET /: plain text.
- Stick stream, port 81: GET http://192.168.4.1:81/stream (MJPEG).
- Key app files:
  - Stick link: src/core/transport/httpTransport.ts and stickHttp.ts (fallback paths: bound stick Wi-Fi → native default route → WebView fetch).
  - Setup: src/core/provisioning/provisioning.ts.
  - Packet check: src/core/telemetry/pipeline.ts (explainPacket).
  - Plugin wrapper: src/core/native/aissNative.ts.
  - Location: src/core/location/locationService.ts and src/core/native/aissLocation.ts.
  - SOS: src/core/safety/sos.ts, src/core/location/shareLocation.ts, src/core/phone.ts.
  - Maps: src/core/maps/destinationSearch.ts and src/core/navigation/realNavigator.ts.
  - AI tools: shared/tools.ts and src/core/ai/executor.ts.
  - Test pages: src/features/user/ConnectionTest.tsx and LocationTest.tsx.
  - Firmware: firmware/ai_smart_stick_v1/Api.cpp and Net.cpp.

RULES (must follow)
1. No fake data in real mode. Never show a fake battery, location or "connected". Demo mode (?mode=demo) is separate and must keep working.
2. Keep the simple link with no keys. Do NOT add HMAC, keys, pairing codes, provisioning, BLE or a mandatory Wi-Fi scan. Do NOT change the SSID, password or IP.
3. Never resolve a Promise with a Capacitor plugin object. No `.then((m) => m.SomePlugin)` and no async function that returns the plugin. This was the real cause of the "Connecting forever" bug. tests/stick-e2e.test.ts guards it.
4. Do not weaken the stick's obstacle safety loop or motor logic.
5. Keep line endings. Many files are CRLF. Make small, exact edits. Never rewrite or reformat a whole file. Check that `git diff --stat` shows only small changes.
6. After any change, run: `npx vitest run`, `npx tsc --noEmit -p .`, `npm run android:typecheck`, `npm run test:firmware`. If you change functions/, tell me to run: `cd functions && npm run build && firebase deploy --only functions`.
7. Fix ONLY the first failing step. Then test again. Do not change many things at once.

STEPS
1. Run `npm run doctor:fix`. Fix only what it reports as FAIL.
2. Phone on USB: run `npm run apk:install`.
3. Flash the firmware: in Arduino IDE open firmware/ai_smart_stick_v1 (board: ESP32-CAM, core 2.0.x) and upload. Or run `npm run doctor -- --firmware --port COM5`. Then open Serial Monitor at 115200 baud.
4. On the phone, open the Connection test (Home → tap the stick picture → Diagnostics → Connection test), wait until it finishes, tap "Copy report" and paste it here. The steps mean:
   - "Phone Wi-Fi": what Android sees (current SSID, requested, bound, SDK).
   - "Join SmartStick_AI": the app asks Android to join and bind the stick Wi-Fi.
   - "GET /api/v1/device": the stick answers who it is.
   - "GET /api/v1/telemetry": one sensor packet (HTTP status, bytes, valid JSON, and "packet OK" or WHICH field failed).
   - "Live link (Home)": the same link Home uses (state, detail text, packet count, path). It must be connected, with the packet count going up.
   - "GET /api/v1/capture (camera)": a JPEG from the camera.
   - "Which way reaches the stick": which of the 3 paths work (bound / default / WebView).
5. Open the Location test (Map → Test location, or Diagnostics → Location test). Tap "Get position", wait 10 s, tap "Copy report" and paste it here. It shows the permission (precise or approximate), the location switch, the status, the last fix with its source and age, the update counts per source, the fallbacks, the Android providers and a log.
6. Run `npm run logcat`. Open the app, stay on Home for 30 s, then on Map for 30 s. Read the lines with [SMARTSTICK] (tag AissNative and Capacitor/Console), [LOCATION] (tag AissLocation) and AndroidRuntime, and the red "!" lines.
7. Compare with the stick's Serial Monitor:
   - "[WIFI] phone joined / got IP" means the phone is on the stick Wi-Fi.
   - "[HTTP] GET /api/v1/telemetry 200 ...B" means the app's requests reach the stick.
   - "[TELEMETRY] seq= us= zone= bat=" means the sensors work.
   - If there are no [HTTP] lines while Home says Connecting, the phone is not reaching the stick. Look at the Join/bind lines.
   - If there ARE [HTTP] lines, the data arrives, and the app drops it. Look at "Stick data rejected: <field>" and pipeline.ts.
8. Find the FIRST step that fails (in the Connection test, the Location test or logcat). Explain the cause to me in simple words with the exact log line. Make the smallest fix that follows the rules.
9. Run `npm run doctor:fix` again, then `npm run apk:install`, and repeat steps 4 to 8 until every step passes.

My reports (I paste them below):
[Connection test report]
[Location test report]
[logcat lines]
[Serial Monitor lines]
```
