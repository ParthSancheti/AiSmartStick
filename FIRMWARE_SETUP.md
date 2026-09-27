# ECU firmware — build, flash, test

Code: `firmware/ai_smart_stick_v1/` (Arduino-ESP32 2.0.x or 3.x, board **AI Thinker ESP32-CAM**).

| Module | Responsibility |
|---|---|
| `BoardConfig.h` | Pins (audited, see HARDWARE_WIRING.md), timings, firmware version |
| `SafetyLogic.h` | **Pure C++**, host-tested: `ObstacleFsm` (median-of-3, thresholds, hysteresis, confirmation, stale → unknown), `FallDetector`, `IdRing` (command idempotency) |
| `Drivers.*` | Motor (LEDC PWM, named patterns, priorities COMMAND < FEEDBACK < SAFETY); ultrasonic (interrupt, no `pulseIn`); MPU6050; INA219; button (debounce); camera lifecycle (JPEG from the sensor, re-init after 3 failures, power-down in sleep) |
| `Ecu.*` | Shared state snapshot and event queues between the control loop and the HTTP task (critical sections) |
| `DeviceConfig.*` | Canonical versioned configuration: validation, NVS persistence |
| `Identity.*` | Device id, setup code, key in NVS, HMAC, replay protection |
| `Net.*` | Station with exponential backoff, setup AP, signed discovery |
| `Health.*` | Reset reason, RTC boot counter, safe mode after 3 quick crashes, heap watermark |
| `Api.*` | `esp_http_server` on core 0: device, status, telemetry, config, capture, command, provision |
| `stick_main.cpp` | P0–P4 loop, safety controller (zone → motor), fall → safety event, local SOS-hold feedback, sleep/wake, 8 s task watchdog |

## Scheduling
The loop runs on core 1 at about 500–900 Hz:
* **P0 safety:** every iteration.
* **P1 input:** every iteration.
* **P2 health:** battery every 500 ms, health every 1 s, Wi-Fi tick.

**P3 camera** and **P4 telemetry** run in the HTTP task on core 0 and only read a snapshot. The only
busy-wait is the 10 µs trigger pulse. There is no `delay()` in the loop apart from a 1 ms yield, no
`pulseIn`, and no blocking network call.

## Build
```bash
arduino-cli core install esp32:esp32
arduino-cli compile --fqbn esp32:esp32:esp32cam firmware/ai_smart_stick_v1
npm run test:firmware        # host unit tests of SafetyLogic.h (g++)
```
Verified here: compiles with no warnings on core 2.0.9, 891,885 B flash (28 %) and 56,900 B static
RAM (17 %). Host tests: 25/25 pass. `ArduinoJson.h` (v7.4.2, MIT) is vendored as a single header.

## Flash (first time)
1. Put GPIO0 to GND (the ESP32-CAM-MB board does this automatically) and **don't press the button**
   (it shares RX).
2. `arduino-cli upload -p /dev/ttyUSB0 --fqbn esp32:esp32:esp32cam firmware/ai_smart_stick_v1`
3. Recommended once: `espefuse.py --port /dev/ttyUSB0 set_flash_voltage 3.3V` (makes GPIO12 boot-safe).
   This is irreversible; read HARDWARE_WIRING.md §1 first.
4. Serial (115200) prints the device id and the **setup code**. Print both on the stick label as text
   and a QR.

## OTA Updates
OTA updates are handled via `POST /api/v1/ota`. The design:
1. The app downloads a signed release manifest `{version, sha256, binaryUrl}` from GitHub Releases (proxied via Cloud Function `getLatestFirmwareRelease`).
2. It verifies the version against the current stick firmware.
3. It downloads the binary from the `binaryUrl`.
4. It streams the image to the authenticated `POST /api/v1/ota` (HMAC-signed with the shared `deviceKey`).
5. The ECU writes to the passive `esp_ota` partition, verifies the SHA-256 (part of the signature payload), and switches the boot partition.
6. Rollback happens if the new image doesn't reach `health::markStable()` (60 s) within 3 boots.
7. The update is refused below 30 % battery or while charging is unknown.

## Hardware test procedure (run with the app: Settings → Hardware)
| # | Test | How | Pass |
|---|---|---|---|
| 1 | Boot | Power on 20 times | `resetReason=power_on`, no `brownout`, `mode=normal` |
| 2 | Provisioning | Hold 5 s → app setup | "AI Smart Stick Connected" only after proof |
| 3 | Authentication | Factory reset → old phone | Link `auth_failed` |
| 4 | Button | Single, double, triple, 3 s hold, 50× each | ≥ 98 % correct; SOS buzz at 3 s |
| 5 | Motor | Self-test, Find stick, strength 20 → 100 % | Felt; safety pattern at 60 % or more even at 20 % |
| 6 | Ultrasonic | 30, 60, 100, 200, 350 cm; open space; cover the sensor | ±5 cm; zones change without chatter; open space shows no_echo/normal; covered sensor gives `unknown` + `sensor_fault` |
| 7 | IMU | Tilt ±30°; drop onto a mattress from 1 m and leave it lying | Stick visual follows; a fall event with confidence ≥ 0.8; a hard tap while upright gives no fall |
| 8 | Battery | Multimeter at 3 loads; plug in the charger | V within 1 %; charging detected; no percentage jumps |
| 9 | Camera | Self-test ×100 | JPEG every time; `heapMin` stable (no leak) |
| 10 | Telemetry | 30 min connected | seq continuous, latency < 1.2 s, no `degraded` |
| 11 | Remote command | Guardian: Find the stick | Buzzes once even when relayed twice (`duplicate`) |
| 12 | SOS | Hold 3 s, let it send | Guardian push, acknowledge heard |
| 13 | Reconnect | Hotspot off for 2 min, then on | Reconnects without re-pairing; config re-applied |
| 14 | Power cycle / watchdog | Pull power during capture; induce a hang in a debug build | Recovers; 3 quick crashes gives `mode=safe` |
