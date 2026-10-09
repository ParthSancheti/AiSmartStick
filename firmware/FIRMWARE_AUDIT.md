# Firmware audit — AI Smart Stick (ESP32-CAM)

## 0. Status of this audit

**The test firmware you described was not included in `public.zip`.** Only the app source and a
`dist/` build were supplied. This audit therefore covers:

1. Every issue the master prompt says the test firmware has (`/data`, `/motor`, `/stream`, blocking
   `delay()` in motor commands, `pulseIn`, QVGA RGB→JPEG conversion, MPU6050 + INA219 on I2C,
   `battery_pct`, `is_charging`), checked against the AI-Thinker ESP32-CAM hardware.
2. A reference firmware, `ai_smart_stick_v1/`, that implements protocol v1 and fixes those issues.
   **It compiles** (Arduino-ESP32 2.0.9, board `esp32cam`: 851 KB flash / 54 KB static RAM, no
   warnings) but **has not run on hardware**.

Send the original `.ino` and I will diff it line by line against this checklist and your real wiring.

## 1. GPIO map — AI-Thinker ESP32-CAM

| GPIO | Used by | Safe for sensors? | Notes |
|---|---|---|---|
| 0 | Camera XCLK, **boot strap** | No | LOW at reset = download mode |
| 1 / 3 | UART0 TX/RX | Only if serial is not needed | Flashing and logs use them |
| 2 | SD D0, **boot strap** | Yes, with care | Must be LOW/floating at reset; HC-SR04 ECHO idles LOW, so it is acceptable |
| 4 | SD D1 + **flash LED** transistor | Yes, if the LED is removed | Any HIGH lights the very bright LED |
| 5, 18, 19, 21, 22, 23, 25, 26, 27, 32, 34, 35, 36, 39 | Camera | **No** | 26/27 = camera SCCB (I2C) |
| 12 | SD D2, **MTDI strap (flash voltage)** | Output only, with care | HIGH at reset → 1.8 V flash → boot loop. Needs a pull-DOWN |
| 13 | SD D3 | Yes | Safest free pin |
| 14 | SD CLK | Yes | |
| 15 | SD CMD, MTDO strap | Yes | Must not be held LOW at reset (silences boot log only) |
| 16 | **PSRAM CS** | **Never** | Using it crashes the camera |

Proposed mapping (in `config.h`; **not taken from your wiring**):

| Function | Pin | Hardware decision required |
|---|---|---|
| I2C SDA / SCL (MPU6050 0x68, INA219 0x40) | 15 / 14 | Check both boards have pull-ups (typically 4.7–10 kΩ). Do not share the camera's SCCB bus (26/27) |
| HC-SR04 TRIG | 13 | — |
| HC-SR04 ECHO | 2 | **5 V → 3.3 V divider is mandatory** (e.g. 1 kΩ / 2 kΩ). Raw 5 V damages GPIO2 |
| Vibration motor | 12 | Must be driven through a MOSFET/NPN with a flyback diode, with a 10 kΩ pull-down on the gate/base. Never drive the motor from the pin directly |
| Button | 4 | Remove the flash-LED transistor, or move the button to GPIO3 and give up serial RX |
| Charger STAT (optional) | — | If the TP4056/charger CHRG pin is wired, set `PIN_CHARGE_STAT`; charging then becomes "hardware", not "inferred" |

If your current wiring uses GPIO 16, 0, a camera pin, or drives 12 high at boot: **do not
silently change it**. That wiring has to be changed on the hardware first.

## 2. Findings checklist (test firmware → reference fix)

| # | Area | Risk in the test firmware (as described) | Reference firmware |
|---|---|---|---|
| 1 | Motor | `delay()` inside `/motor` freezes the HTTP server, telemetry and the button for the whole pattern | Pattern state machine (`motorTick`), no `delay()`; commands return immediately |
| 2 | Ultrasonic | `pulseIn()` blocks up to 1 s by default (≈23 ms at 4 m) on every read; no-echo looks like "0" | Echo measured by pin-change interrupt, trigger every 70 ms, explicit `no_echo` / `out_of_range` / `invalid` status |
| 3 | Camera | QVGA RGB565 + `frame2jpg` conversion: slow, heap-hungry, fragments memory | `PIXFORMAT_JPEG` from the sensor, `CAMERA_GRAB_LATEST`, 2 buffers in PSRAM, JPEG bytes sent unmodified. **Update (1.2.1):** only on OV2640/OV3660/OV5640. Clone boards with other sensors (no JPEG) stay on RGB565 in PSRAM + `camera::toJpeg`, as the field-proven sketch did. |
| 4 | Camera API | Browser `<img src=/stream>` as the only camera path; one MJPEG client blocks others | `/api/v1/capture` returns one validated JPEG + width/height/seq headers. MJPEG is not part of the product protocol |
| 5 | HTTP server | Arduino `WebServer` handled in `loop()`: every slow handler stalls sensors | `esp_http_server` in its own task (5 sockets, LRU purge); `loop()` never blocks |
| 6 | Concurrency | Capture + telemetry at once | `camBusy` → 409 `busy` rather than blocking; telemetry is independent |
| 7 | Battery | `battery_pct` computed on the device (usually linear from voltage) | Raw INA219 bus V, shunt mV and current; the app does state of charge. `battery_pct` from old firmware is **not trusted** (see §4) |
| 8 | INA219 | Unknown calibration; current may be 0 without calibration register | Current computed from shunt voltage / `INA219_SHUNT_OHM` (0.1 Ω default). Verify your shunt value and polarity (§4) |
| 9 | I2C | Polling both sensors every loop; no presence/error handling | MPU6050 at 20 Hz, INA219 at 2 Hz, 20 ms bus timeout, `i2c: error` reported in health |
| 10 | IMU | pitch/roll only, no failure state | Raw accel/gyro + pitch/roll + `ok`; calibration done in the app (zero reference) |
| 11 | Button | Level (`button_state`) only: presses between polls are lost; no debounce | 25 ms debounce, press/release events with device timestamps and ids (queue of 16); app classifies single/double/triple/long |
| 12 | Watchdog | None | Task watchdog on `loop()` (8 s) |
| 13 | Heap | `String` concatenation for JSON | Fixed static buffers, `snprintf` |
| 14 | Wi-Fi | Hardcoded SSID/password; no reconnect | NVS credentials from provisioning, auto-reconnect, `WiFi.setSleep(false)` for latency |
| 15 | Provisioning | None | 5 s hold (unprovisioned) → WPA2 SoftAP `AISmartStick-XXXX` with the 8-character setup code; 10 s hold → factory reset |
| 16 | Auth | Any device on the hotspot can read sensors, trigger the motor and view the camera | HMAC-SHA256 on every request, replay protection, challenge/response proof, signed discovery |
| 17 | Commands | Unvalidated | Allow-list: `haptic` (named patterns only), `locate`, `calibrateImu`, `reboot`, `factoryReset` |
| 18 | Local safety | Vibration may depend on the app | Obstacle vibration runs on the stick itself (<100 cm warning, <50 cm danger), with or without the phone |

## 3. Setup code
The reference firmware generates an 8-character code on first boot, stores it in NVS and prints it on
serial. **Print it on the stick label (and a QR) during assembly.** It is the SoftAP WPA2 password and
the proof of physical possession during pairing.

## 4. Battery hardware questions (need your answers)
* Is the INA219 **high-side on the battery**, so it measures the cell, not the 5 V boost output? A reading
  of about 5 V means it is on the wrong rail; the app then reports "sensor error", never a percentage.
* Shunt value (the board marking R100 = 0.1 Ω) and current direction. The app assumes positive current
  means discharging; flip `BATTERY_CONFIG.currentSign` in `src/core/telemetry/battery.ts` if yours is
  reversed.
* Single-cell Li-ion/LiPo? The app's OCV curve is for 1S (3.27–4.20 V).
* Is a charger STAT pin available? Without it, charging is **inferred** from sustained negative
  current, and the UI says so.

## 5. ECU boundary
Fall detection and any fusion logic belong to the ECU (Arduino Nano or future firmware). The protocol
already carries processed events: `TelemetryPacket.safety[] = {id, type: 'fall' | 'obstacle' |
'sensor_fault', atMs, value, confidence}`. The app turns `fall` into the SOS countdown when the user
enabled fall detection. The reference firmware sends raw IMU data and an empty `safety[]`. **No fall
algorithm was invented.** Options:

* **Nano as ECU:** the Nano reads the sensors and runs detection, then sends JSON lines over UART to the
  ESP32 (on free pins with a level shifter). The ESP32 merges them into `/api/v1/telemetry`.
* **ESP32 as ECU:** add the detector in `imuTick()` and push `safety` events.
