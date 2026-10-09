# Real-device acceptance test

Everything below needs a phone and the stick. Unit and integration tests in this repo prove the
protocol and logic; only this test proves the product.

## 0. Build and install

```bash
npm ci                     # also copies the MediaPipe WASM into public/ (postinstall)
cp .env.example .env       # fill the VITE_* values (Firebase web config, Maps browser key + Map ID)
npm run android:sync       # vite build + npx cap sync android
# open android/ in Android Studio → Run (or ./gradlew installDebug)
```

Server side (once): deploy functions with `GEMINI_API_KEY` and `MAPS_SERVER_KEY` secrets and
`GEMINI_LIVE_MODEL` set to a Live-capable model your key can use (`npm --prefix functions run deploy`).

Sideloaded / debug APKs fail Play Integrity. For them set `VITE_APPCHECK_DEBUG=true`, run once,
copy the App Check debug token from logcat into Firebase console → App Check → Manage debug tokens.

Stick firmware: unchanged by this recovery (`firmware/ai_smart_stick_v1`). It must be the dashcam
build: access point `SmartStick_AI` / `Stick@1234`, 192.168.4.1. A stick paired with another phone
or an earlier install must be factory-reset: hold the button while switching it on (5 s).

## Where to look when a step fails

* **Stick → Stick details** shows the camera frame with live detections and the data-flow counters:
  Connected → Packets received → Packets valid → Telemetry parsed → Store updated → Button events →
  Frames received → Detections run (count + seconds since last). The first counter that stops is the
  broken hop.
* Triple-tap the bottom-right corner: detection engine debug (detector state and its error text).
* Per-packet console tracing: `localStorage.setItem('aiss.trace','1')` in `chrome://inspect`.

## Checklist

| # | Step | Expected |
|---|------|----------|
| 1 | Fresh install | 3 intro cards, swipe or Next; Back goes to the previous card |
| 2 | Google sign-in | Lands on **Set up SmartStick** |
| 3 | Set up SmartStick → Allow access | Location, Nearby devices, Microphone, Notifications prompts; each shows Allowed/Denied |
| 4 | Profile photo | Google photo (or initials); later shows instantly on Home, also offline |
| 5 | Location | Type "SNJB" → nearby results; pick → map animates, pin drops, card rises → Use this location |
| 6 | Safety number | +91 fixed; 10-digit validation; SMS permission prompt; optional test message reports sent / Messages opened / failed |
| 7 | Wi-Fi | Opens scanning automatically: SCANNING → FOUND → (Android "Connect to device?") → CONNECTING → CONNECTED → Home |
| 8 | Live telemetry | Stick details: Packets received/valid/parsed/store updated counting up every ~0.5 s |
| 9 | Battery | Real % with voltage and current; if the INA219 is mis-wired the battery screen says why instead of a % |
| 10 | Ultrasonic | Obstacle sensor distance changes with your hand |
| 11 | IMU | Stick picture tilts with the stick |
| 12 | Camera | Stick details shows a fresh camera frame, Frames received counting |
| 13 | EfficientDet | A person / chair / bottle gets a box with a label |
| 14 | Tracking | The same object keeps the same `#id` while it stays in view |
| 15–19 | Map, search, route, start | Map opens on your position; search a real place; route line appears; spoken "Walking to …, N metres …" |
| 20 | Stick AI button | One press: connecting tone, then listening (mic indicator) |
| 21–22 | "Take me to the nearest barber" | Assistant names a real nearby barber and its distance and asks to go |
| 23–24 | "Yes" | Navigation starts by itself (no tap); assistant confirms; route on the map |
| 25–28 | Lock the screen | Turn instructions keep coming; GPS progresses; stick vibrates at turns |
| 29–30 | Leave the route | "You are off the route…" then "New route found." |
| 31–32 | Arrive | One arrival announcement; navigation ends |
| 33–34 | Unlock | The app shows the same state; reopening the app restores the last page; killing the app mid-walk resumes directions on the next launch |

Android limits that are expected, not bugs: Android may still kill the app on some OEM ROMs with
aggressive battery savers. Set the app to "Unrestricted" battery use (Settings → Background).
The Wear-style "always listening" is not supported: the assistant listens only after a button press.
