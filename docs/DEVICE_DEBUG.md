# Real-device test & debug guide

The newest round is at the top. The older rounds follow below it.

## Round 6: camera view, live video, AI vision, maps

Your report said: no camera view, no live video, AI vision failed, and map search failed with
"Server search: Could not reach the server ... In-app search: Places API (New) has not been used in
project 599970506387 or it is disabled". This round fixes the app side. The Google side is a setting
you must change: see "Maps" below and [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md).

### Where to find the camera

1. **Camera card on Home.** Scroll down a little. It is below the **Safety** and **Assistant** buttons,
   above "Audio output". It says **CAMERA, See what the stick sees** and shows a small live picture.
2. **Tap the card.** The full-screen **Camera** page opens. It shows:
   * the live picture, with boxes around objects (for example `#3 person 87%`);
   * one line about the picture, for example `Live video · 6 fps · 320×240`;
   * one line about object detection, for example `Detecting objects`;
   * the big button **Describe what the camera sees**.

   The phone's back button closes the page.
3. The Stick diagnostics page (Home → tap the stick picture) also shows the live picture, under
   "Camera & detection".
4. **Describe what the camera sees:** tap it. It says "Looking…". Then the answer shows under the
   button, and the app reads it aloud (when the assistant voice is on). It sends one picture to the AI
   (one AI request), so it needs internet (mobile data).

### How the live video works

* The stick sends live video (MJPEG) at `http://192.168.4.1:81/stream`.
* **The stick serves only ONE viewer at a time.** If a Chrome tab (on a laptop or a phone) has
  `http://192.168.4.1:81/stream` open, the app gets no video. **Close that tab.** Within about 30
  seconds the app shows live video again.
* The app reads the video in its Android code (AissNativePlugin.java), over the stick Wi-Fi network.
  The web part of the app cannot reach the stick by itself. Mobile data stays the phone's internet.
* If the video gives no picture for 6 seconds, or fails 3 times in a row, the app takes single photos
  instead (`/api/v1/capture`, about 2 per second). It tries the video again after 30 seconds.
* The video runs only while the app is open on the screen, and only while a camera view is visible or
  object detection is running. In the background it stops. It starts again when you come back.
* While the video runs, `/api/v1/capture` answers **409 (busy)**. That is normal. The AI then uses the
  newest video picture. The Connection test shows this as INFO "HTTP 409: camera busy".
* The old Chrome test (`:81/stream` in Chrome, round 5 below) still works, but only while the app
  shows no camera and object detection is off. Best: close the app for that test.

### What the camera texts mean

The small label on the picture (the "chip"):

| Text on the picture | Meaning | What to do |
|---|---|---|
| `Live · 6 fps` | Live video works (6 pictures per second). | Nothing. |
| `Snapshots · 2 fps` | The video did not work. The app shows single photos. | Close other viewers (Chrome tab). Wait 30 s for the video. |
| `Connecting to camera…` | The app is starting the video. | Wait 5 to 10 s. |
| `No new frames` | No new picture for more than 3 s. The old picture turns grey. | Come closer to the stick. Wait. If it stays, restart the stick. |
| `Stick not connected` | The stick link is down. | Connect the stick. |
| `Camera off` | Nobody is watching the camera now. | Open the Camera card or page. |
| `Camera stream busy: another phone or browser is watching the stick camera. Close it and try again.` | Another viewer has the video. | Close the Chrome tab or the other phone's camera page. |
| `No camera frames from the stick.` | The video connection gives no pictures. | Restart the stick. Send the Serial Monitor `[camera]` and `[stream]` lines. |
| `The stick camera is not working. Restart the stick.` | The stick's camera reports an error. | Restart the stick. Send the `[camera]` lines. |

The line under the full-screen picture:

* `Live video · 6 fps · 320×240`: video, its speed and its size.
* `Snapshots (one photo at a time) · …`: single photos instead of video.
* `Connecting to camera…` or `No picture yet`: no picture has arrived yet.

The object detection line: `Loading object detection…` (starting), `Detecting objects` (working),
`Object detection waits for the stick`, `Object detection paused`, `Object detection is off`,
`Object detection failed to load` (then an orange box says why). The picture never waits for object
detection.

### AI vision

* "Describe what the camera sees" and the assistant ("What is in front of me?") send one picture to
  the server. The picture is the newest video picture (at most 1 s old), or one photo from the stick.
* When it fails, the app now says **why** in simple words: the stick camera did not answer, the camera
  is busy, no internet, App Check refused, or the AI key is missing on the server. The full list of
  texts and fixes: [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md), "Message in the app → what to do".
* AI vision needs: mobile data, sign-in, App Check (or `ENFORCE_APPCHECK=false` for a test), the
  `GEMINI_API_KEY` secret, and deployed functions.

### Server & maps test (new)

Home → tap the stick picture → **Diagnostics** → **Server & maps test**. (Or: profile picture → Settings
→ Stick & hardware → Diagnostics → Server & maps test.)

It checks every hop from the phone to Google: internet, Firebase config, sign-in, App Check, the
server (`serverPing`), Google search on the server and in the app, the in-app route, OpenStreetMap, and
the voice token. Each failed step has an orange line with what to do, and names a section of
[GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md). **Copy report** gives a text without keys or tokens.
**Test AI vision** sends one stick photo to the AI.

### Maps: search and routes keep working

1. The server search (Cloud Function, server key) starts first.
2. The in-app Google search (browser key) joins after 3.5 seconds, or at once when the server fails.
   The first answer wins.
3. Only when **both** Google paths fail, the app uses **OpenStreetMap**: Photon for search and the
   FOSSGIS OSRM foot router for walking routes. These are free public services, a bit slower. Search
   on OpenStreetMap needs 3 or more letters.
4. When places or a route come from OpenStreetMap, the app shows **© OpenStreetMap contributors**
   (under the search list, on the walking page, in the home address step, and on the Guardian map).
   OpenStreetMap's licence requires this line.
5. After 5 seconds without an answer, the search says "Still searching… the server is slow to start."
6. When everything fails, the text names each part, for example
   `Search unavailable. Server search: … Also: In-app search: … Also: OpenStreetMap: …`.

Your error means Places API (New) is off in project 599970506387. Fix: open
https://console.cloud.google.com/apis/library/places.googleapis.com?project=599970506387, click
**Enable**, wait about 5 minutes. Do the other steps in [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md)
too (APIs, both keys, App Check).

### Test steps (round 6)

1. PC: run `npm run doctor:fix`. The check **Maps key (Places API)** must be PASS. Fix every FAIL.
2. Google Cloud and Firebase: do [GOOGLE_CLOUD_SETUP.md](GOOGLE_CLOUD_SETUP.md) sections 1 to 6. For a
   test APK, use App Check option A (debug token) or option B (`ENFORCE_APPCHECK=false`).
3. Deploy the functions (there is a new function, `serverPing`):
   `cd functions && npm run build && firebase deploy --only functions`
4. Phone on USB: `npm run apk:install`. The firmware stays 1.2.1 (no firmware change in this round).
5. Close every Chrome tab with `192.168.4.1:81/stream`. Turn on mobile data. Connect the stick (Home
   shows it connected).
6. **Server & maps test:** every step should be PASS. "In-app Google route" may FAIL: that is OK when
   "Server ping" shows `routes ok`. Tap Copy report.
7. **Camera card:** within about 10 seconds the chip says `Live · … fps`. Move your hand in front of
   the stick camera: the picture moves.
8. **Camera page:** tap the card. The line says `Live video · …`. After "Loading object detection…"
   ends, hold a bottle in front of the camera, or stand in front of it: boxes appear.
9. **Describe:** tap "Describe what the camera sees". Within about 20 seconds an answer shows and is
   read aloud. Then ask the assistant by voice: "What is in front of me?". It must describe the
   scene. If something is wrong, it must say why (for example App Check), not only "error".
10. **One viewer:** on a laptop joined to SmartStick_AI, open `http://192.168.4.1:81/stream`. The app
    shows "Camera stream busy…" (or `Snapshots`). Close the tab. Within about 30 seconds the chip says
    `Live` again.
11. **Background:** press the phone's Home button, wait 10 seconds, open the app again. The video comes
    back within a few seconds.
12. **Maps:** open the Map and type "hospital". A list must show. Pick one: the walking route starts.
    If "© OpenStreetMap contributors" shows under the list, Google search failed: run the Server &
    maps test to see why.
13. **Connection test:** still every step PASS. "GET /api/v1/capture (camera)" may say INFO "HTTP 409:
    camera busy" while the video runs. That is OK.

### If something fails, send me these (round 6)

1. **Server & maps test report:** Diagnostics → Server & maps test → wait → **Copy report**. Paste all
   of it. If the stick is connected, tap **Test AI vision** first.
2. **Connection test report:** Diagnostics → Connection test → wait → **Copy report**.
3. **Phone log:** phone on USB, run `npm run logcat`. Open Home for 30 s (camera card visible), open the
   Camera page, tap Describe, then search "hospital" on the Map. Copy these lines:
   * `[SERVER] …`: one line per server call with its result, for example `[SERVER] mapsSearch ok 850ms`
     or `[SERVER] assistantVision unauthenticated 120ms`.
   * `[SMARTSTICK] server test: …`: every step of the Server & maps test.
   * `[SMARTSTICK] stream: …` (tag `AissNative`): the Android video reader. `via stick` is right.
     `via default` means the stick Wi-Fi binding was lost.
   * `[SMARTSTICK] camera stream: …`, `[SMARTSTICK] camera: single photos (…)` and
     `[SMARTSTICK] camera: live stream back`: the app's camera hub.
   * `[VISION] …` and `[app-check] …`.
   * every line with the tag `AissNative` or `AndroidRuntime`, and all red `!` lines.
   * Do **not** send the green `>>` debug secret line. That code is a secret.
4. **Stick log:** Arduino IDE → Serial Monitor at 115200 baud, while the app shows the camera. Copy the
   `[stream]` lines (for example `[stream] viewer connected`, `[stream] no frames, closing the stream`),
   the `[camera]` lines and the `[HTTP]` lines with `/api/v1/capture`.
5. **Exact texts:** the chip on the picture, the orange box under the Camera picture, the Describe
   answer, and the text under the map search box.
6. A screenshot of the Camera page.

## Round 4: what was wrong

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

## Test on the phone (round 4)

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

## If something fails, send me these (round 4)

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
- Native plugins: android/app/src/main/java/in/aismartstick/app/AissNativePlugin.java (joins the stick Wi-Fi and makes HTTP requests through that network; reads the MJPEG camera stream over that network with startStream/stopStream and the events streamFrame/streamState; also SMS) and AissLocationPlugin.java (LocationManager GPS).
- Firebase Auth, Firestore and Cloud Functions (folder functions/, region asia-south1). Google setup guide: docs/GOOGLE_CLOUD_SETUP.md.
- Stick: ESP32-CAM. Firmware: firmware/ai_smart_stick_v1, Arduino-ESP32 core 2.0.x, version 1.2.1. Camera: clone sensor without JPEG, so RGB565 + frame2jpg (Drivers.cpp camera::begin / toJpeg).
- The stick is ALWAYS its own Wi-Fi access point: SSID "SmartStick_AI", password "Stick@1234", IP 192.168.4.1. No auth (REQUIRE_AUTH 0).
- Stick endpoints, port 80:
  - GET http://192.168.4.1/api/v1/device: JSON, who the stick is (fw 1.2.1).
  - GET /api/v1/telemetry: JSON sensor packet. These are the Home numbers: battery, distance, zone, pitch.
  - GET /api/v1/status and GET /api/v1/config: JSON.
  - GET /api/v1/capture: one camera JPEG.
  - POST /api/v1/command: commands.
  - GET /: plain text.
- Stick stream, port 81: GET http://192.168.4.1:81/stream (MJPEG). The stick serves ONE stream viewer at a time. While the stream holds the camera, /api/v1/capture answers 409 (busy).
- Key app files:
  - Stick link: src/core/transport/httpTransport.ts and stickHttp.ts (fallback paths: bound stick Wi-Fi → native default route → WebView fetch).
  - Setup: src/core/provisioning/provisioning.ts.
  - Packet check: src/core/telemetry/pipeline.ts (explainPacket).
  - Plugin wrapper: src/core/native/aissNative.ts.
  - Location: src/core/location/locationService.ts and src/core/native/aissLocation.ts.
  - SOS: src/core/safety/sos.ts, src/core/location/shareLocation.ts, src/core/phone.ts.
  - Live camera: src/core/camera/liveStream.ts (the one frame hub: native / web / snapshot sources), src/components/LiveCameraView.tsx and liveCameraText.ts, src/components/LiveVisionPanel.tsx, src/features/user/CameraView.tsx (full-screen Camera page), the Camera card in src/features/user/UserHome.tsx.
  - Vision: src/core/vision/relay.ts (captureFrame), framePipeline.ts, visionLoop.ts.
  - Server calls: src/core/backend/api.ts ([SERVER] log lines), src/core/firebase/app.ts and src/core/firebase/appCheckStatus.ts (App Check).
  - Maps: src/core/maps/destinationSearch.ts, mapsService.ts, osmFallback.ts (OpenStreetMap last resort) and src/core/navigation/realNavigator.ts.
  - AI tools: shared/tools.ts and src/core/ai/executor.ts.
  - Test pages: src/features/user/ConnectionTest.tsx, LocationTest.tsx and ServerTest.tsx (Server & maps test).
  - Server: functions/src/health.ts (serverPing), functions/src/maps.ts, functions/src/assistant.ts, functions/src/common.ts (ENFORCE_APPCHECK).
  - Firmware: firmware/ai_smart_stick_v1/Api.cpp and Net.cpp.

RULES (must follow)
1. No fake data in real mode. Never show a fake battery, location or "connected". Demo mode (?mode=demo) is separate and must keep working.
2. Keep the simple link with no keys. Do NOT add HMAC, keys, pairing codes, provisioning, BLE or a mandatory Wi-Fi scan. Do NOT change the SSID, password or IP.
3. Never resolve a Promise with a Capacitor plugin object. No `.then((m) => m.SomePlugin)` and no async function that returns the plugin. This was the real cause of the "Connecting forever" bug. tests/stick-e2e.test.ts guards it.
4. Do not weaken the stick's obstacle safety loop or motor logic.
5. Keep line endings. Many files are CRLF. Make small, exact edits. Never rewrite or reformat a whole file. Check that `git diff --stat` shows only small changes.
6. After any change, run: `npx vitest run`, `npx tsc --noEmit -p .`, `npm run android:typecheck`, `npm run test:firmware`. If you change functions/, tell me to run: `cd functions && npm run build && firebase deploy --only functions`.
7. Fix ONLY the first failing step. Then test again. Do not change many things at once.
8. The stick serves ONE stream viewer. Never add a second stream reader. Every camera frame goes through src/core/camera/liveStream.ts.
9. Never print or log a key, a token or the App Check debug secret.

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
5. Open the Server & maps test (Diagnostics → Server & maps test), wait until it finishes, tap "Copy report" and paste it here. Every failed step names a section of docs/GOOGLE_CLOUD_SETUP.md. Then open the Location test (Map → Test location, or Diagnostics → Location test). Tap "Get position", wait 10 s, tap "Copy report" and paste it here. It shows the permission (precise or approximate), the location switch, the status, the last fix with its source and age, the update counts per source, the fallbacks, the Android providers and a log.
6. Run `npm run logcat`. Open the app, stay on Home for 30 s, then on Map for 30 s. Read the lines with [SMARTSTICK] (tag AissNative and Capacitor/Console; camera video lines start with "stream:" and "camera"), [SERVER] (server calls), [VISION], [app-check], [LOCATION] (tag AissLocation) and AndroidRuntime, and the red "!" lines.
7. Compare with the stick's Serial Monitor:
   - "[WIFI] phone joined / got IP" means the phone is on the stick Wi-Fi.
   - "[HTTP] GET /api/v1/telemetry 200 ...B" means the app's requests reach the stick.
   - "[TELEMETRY] seq= us= zone= bat=" means the sensors work.
   - If there are no [HTTP] lines while Home says Connecting, the phone is not reaching the stick. Look at the Join/bind lines.
   - If there ARE [HTTP] lines, the data arrives, and the app drops it. Look at "Stick data rejected: <field>" and pipeline.ts.
8. Find the FIRST step that fails (in the Connection test, the Location test or logcat). Explain the cause to me in simple words with the exact log line. Make the smallest fix that follows the rules.
9. Run `npm run doctor:fix` again, then `npm run apk:install`, and repeat steps 4 to 8 until every step passes.

My reports (I paste them below):
[Server & maps test report]
[Connection test report]
[Location test report]
[logcat lines]
[Serial Monitor lines]
```
