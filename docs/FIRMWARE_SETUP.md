# ESP32 SmartStick firmware setup

This guide describes the current source in `firmware/ai_smart_stick_v1`. Use that source and this guide when older documents disagree: the historical firmware audit contains an earlier pin map, authentication flow, and sampling description. The current firmware reports version `1.2.1`, model `AISS-ESP32CAM-1`, and protocol `1`.

The refined firmware passed host logic and control-loop tests. **Its ESP32 target build and hardware operation remain unverified in this cloud workspace.** Authoritative Arduino CLI and ESP32-core downloads were blocked by the network proxy with HTTP 403. No board was flashed here, and passing software tests is not physical safety certification.

## Required equipment and software

- AI-Thinker-compatible ESP32-CAM with 4 MB flash and working PSRAM; verify the actual board and camera module rather than relying on its seller description.
- The existing single HC-SR04, MPU6050, INA219, vibration motor with driver circuit, and push button.
- A suitable regulated board supply, common ground, and protected single-cell Li-ion/LiPo battery/charger arrangement. Check the supply and wiring against the actual board and motor specifications.
- ESP32-CAM-MB USB programmer, or a USB-to-UART adapter with **3.3 V logic**, a data-capable cable, and its manufacturer's USB driver when required.
- Arduino IDE 2 or Arduino CLI, with **Arduino-ESP32 by Espressif Systems version 2.0.17** and board **AI Thinker ESP32-CAM** (`esp32:esp32:esp32cam`). Repository tooling targets 2.0.x; 3.x is not validated for this project.
- A C++ compiler for host tests. Node/npm are needed for repository test/doctor commands; direct Arduino compilation does not require the app or cloud backend to run.

`ArduinoJson.h` version **7.4.2** is already bundled beside the sketch. Wi-Fi, Wire, Preferences, camera/JPEG support, ESP-IDF HTTP/OTA/watchdog functions, and mbedTLS come from the ESP32 core. The firmware reads MPU6050 and INA219 registers directly; no extra sensor library is required.

## Wiring and electrical checks

Disconnect power before wiring. These assignments come from `BoardConfig.h`; do not substitute the older audit's suggested GPIO map.

| Connection | ESP32 GPIO / setting | Required checks |
|---|---|---|
| HC-SR04 TRIG | 13 | Verify the module recognizes a 3.3 V trigger. |
| HC-SR04 ECHO | 12 | HC-SR04 ECHO is 5 V: use a suitable divider or level shifter and verify the GPIO-side voltage is within ESP32 limits. |
| Motor driver control | 2 | Use a suitable MOSFET/NPN driver, flyback diode, and gate/base bias circuit; never connect the motor directly to the GPIO. Board configuration calls for a 10 kΩ gate pull-down. |
| Button | 3 | Button to GND, firmware `INPUT_PULLUP`. GPIO3 is also UART RX; do not hold this button while uploading. |
| I2C SDA | 14 | MPU6050 and INA219 share this bus. |
| I2C SCL | 15 | I2C frequency is 400 kHz. Check pull-ups terminate at 3.3 V rather than a module's 5 V supply. |
| MPU6050 address | `0x68` | Confirm the module's AD0/address strap matches. |
| INA219 address | `0x40` | Confirm its address straps match. |
| INA219 shunt | `INA219_SHUNT_OHM = 0.1 Ω` | Check the actual shunt marking/value and current limits. |
| Charger status | `PIN_CHARGE_STAT = -1` | Not wired by default; charging is inferred by the phone when valid current evidence exists. |

GPIO12 is the ESP32 flash-voltage boot strap: an external HIGH during reset can select the wrong flash voltage and prevent boot. Verify ECHO is LOW at reset. GPIO2 must remain LOW/floating for download mode, and GPIO15 is also a boot strap. Do not add a microSD card or peripheral that conflicts with these pins. GPIO16 is reserved by PSRAM on the intended board.

The source comments mention flash-voltage eFuses. **Do not run an eFuse-burning command as a routine setup step.** It is irreversible and requires verified chip, flash, and board details plus a separate hardware procedure.

The camera ribbon uses the board's fixed mapping:

| Camera signal | GPIO |
|---|---|
| PWDN / RESET | 32 / no reset GPIO (`-1`) |
| XCLK | 0 |
| SCCB SDA / SCL | 26 / 27 |
| D7–D0 | 35, 34, 39, 36, 21, 19, 18, 5 |
| VSYNC / HREF / PCLK | 25 / 23 / 22 |

Use the board's documented power input and adequate transient headroom for camera, Wi-Fi, and motor load. A 3.3 V UART logic level does not establish that the adapter's power pin can supply the board. Keep motor-current return paths from disturbing sensor/ESP32 ground, and verify the supply does not brown out when the motor starts. Battery protection and safe charging must exist in hardware; the firmware does not replace them.

### Battery measurement assumptions

The phone's estimator expects **one Li-ion/LiPo cell measured on the battery side**, not the boosted 5 V board rail. The INA219 normally sits high-side between the battery and downstream load. Confirm the exact charger/power topology so charging current is measured as intended, and compare readings with an external meter.

Firmware computes current from shunt millivolts divided by `INA219_SHUNT_OHM`, and power from bus voltage times current. Its convention is positive current while discharging; the phone's `BATTERY_CONFIG.currentSign` is currently `1`. Verify polarity, shunt value, and voltage accuracy before relying on those readings. Do not change calibration assumptions merely to obtain a plausible percentage.

Stick voltage/current/power are hardware measurements only when the sensor and calibration are valid. Displayed state of charge and inferred charging remain estimates. Android phone battery measurements are separate.

## Build with Arduino IDE

1. Install Arduino IDE 2 from <https://www.arduino.cc/en/software>.
2. In Preferences, add this Boards Manager URL:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`.
3. In Boards Manager, install **esp32 by Espressif Systems, 2.0.17**.
4. Open `firmware/ai_smart_stick_v1/ai_smart_stick_v1.ino`. Its sibling `.cpp` and `.h` files contain the implementation; keep the whole directory together.
5. Select **AI Thinker ESP32-CAM**, the correct serial port, and the intended 4 MB flash/PSRAM configuration. The build must enable working PSRAM for the intended camera setup.
6. Keep `partitions.csv` beside the sketch. Arduino-ESP32 uses the sketch's custom table. Verify that the produced application fits **1,310,720 bytes**; a larger generic board-menu size allowance does not enlarge this project's app slot.
7. Click Verify. Resolve compile errors with the pinned core and actual bundled sources before uploading.

The custom partition table has NVS at `0x9000`, OTA metadata at `0xe000`, app slots at `0x10000` and `0x150000` (each `0x140000`, or 1.25 MiB), and SPIFFS at `0x290000` with size `0x160000`. Preserve this layout; changing partitions can invalidate installed firmware/data. The CLI command below explicitly sets the app-size ceiling.

## Build with Arduino CLI

Install Arduino CLI from <https://arduino.github.io/arduino-cli/latest/installation/>. Verify a downloaded release against its published checksum and retain TLS/package verification. The following commands run from the repository root:

```bash
arduino-cli version
arduino-cli core update-index \
  --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core install esp32:esp32@2.0.17 \
  --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core list
arduino-cli compile \
  --fqbn esp32:esp32:esp32cam \
  --jobs 4 \
  --build-path /tmp/aiss-firmware-build \
  --build-property upload.maximum_size=1310720 \
  firmware/ai_smart_stick_v1
```

The `/tmp` example is for Linux/macOS; on Windows use a writable build path or the repository doctor, which chooses the operating system's temporary directory. Record CLI/core versions, flash/RAM output, and warnings for the actual build. Four parallel jobs are a reasonable starting point; reduce them on a memory-limited computer.

The repository provides equivalent firmware-only helpers:

```bash
npm run doctor -- --firmware
# Installs the pinned ESP32 core when arduino-cli is available but the core is missing:
npm run doctor -- --fix --firmware
```

If a managed environment blocks downloads, allow `downloads.arduino.cc`, `espressif.github.io`, and the GitHub/release-download hosts required by the official package index. Reattempt after the network policy changes. Do not work around blocked or failed verification by disabling TLS/checksums or using an unverified binary. The commands above are reproducible instructions, not a claim that a target build succeeded here.

## Upload to the board

Upload only after the wiring/power checks and a successful target compile. Keep the stick on a bench; no one should rely on it for navigation during flashing or mode tests.

1. Connect the programmer and identify the port with `arduino-cli board list`, the IDE, or the operating system's device manager. Install the correct manufacturer's USB driver if the port is absent.
2. For manual UART wiring, cross adapter TX/RX to board RX/TX, connect GND, use 3.3 V logic, and power the board through its documented input. GPIO0 must be LOW at reset to enter download mode. A compatible MB programmer may handle this with its BOOT button.
3. Close Serial Monitor before upload. Hold BOOT/IO0 as required, reset if the uploader remains at `Connecting...`, and release BOOT after writing begins. Keep the stick's GPIO3 button released.
4. In the IDE click Upload, or use the already-built files:

```bash
arduino-cli upload \
  --fqbn esp32:esp32:esp32cam \
  --port /dev/ttyUSB0 \
  --input-dir /tmp/aiss-firmware-build \
  firmware/ai_smart_stick_v1
# Alternative repository helper; replace COM5 with your actual port:
npm run doctor -- --firmware --port COM5
```

5. Disconnect any temporary GPIO0-to-GND programming connection, then press RST to start normally. Open Serial Monitor at **115200 baud** and inspect `[boot]`, `[camera]`, and AP startup messages.
6. Remove the ESP32-CAM from its MB programmer for normal stick-button tests; the repository's prototype notes that the programmer interferes with GPIO3 button operation. Power it through the verified normal supply.

Logs from the current firmware can contain AP credentials. Keep raw logs private and redact credentials before sharing them. Do not factory-reset an already configured device merely to perform an ordinary reflash. The boot-time five-second button hold clears identity/configuration and must be treated as an intentional reset.

## Connect and check the current API

The default firmware runs its own fixed Wi-Fi access point. Join the network configured by `STICK_AP_SSID` using the privately held `STICK_AP_PASS`; this document deliberately contains no password value. The default AP address is `192.168.4.1`. This Wi-Fi link has no internet; Android may need mobile data for cloud features. Local obstacle logic does not require that internet connection.

Current `REQUIRE_AUTH` is `0`. API access depends on joining the AP; these examples do not need HMAC headers. A build with `REQUIRE_AUTH = 1` needs a matching signed-request/provisioning client and is outside this setup procedure. Do not expose the local API or camera through router port forwarding.

From a computer joined to the stick AP:

```bash
curl --fail --max-time 5 http://192.168.4.1/api/v1/device
curl --fail --max-time 5 http://192.168.4.1/api/v1/status
curl --fail --max-time 5 http://192.168.4.1/api/v1/config
curl --fail --max-time 5 http://192.168.4.1/api/v1/telemetry
curl --fail --max-time 6 http://192.168.4.1/api/v1/capture --output /tmp/aiss-capture.jpg
```

Check the returned model/protocol, fresh advancing telemetry sequence/uptime, `health.mode`, sensor error list, and real distance/IMU/battery values. A sensor marked unavailable must not be mistaken for a clear path or a valid battery percentage. The JPEG should be a real fresh picture, not a cached response.

For a one-time bench self-test, clear the area around the motor and close other camera viewers, then send:

```bash
curl --fail --max-time 10 \
  -H 'Content-Type: application/json' \
  --data '{"commandId":"bench-selftest-001","type":"selfTest","payload":{}}' \
  http://192.168.4.1/api/v1/command
```

This requests a short confirmation motor pattern and one camera frame. An active safety pattern takes priority, so a busy result is legitimate. Use a **new `commandId`** for each intended execution; replaying the same ID is acknowledged as a duplicate without rerunning it. Self-test reports status and instructions, not an automated certification of the button or electrical circuit.

Open `http://192.168.4.1:81/stream` for a short MJPEG bench check and close it afterward. There is only one stream viewer. While the stream owns the shared camera, a snapshot may return HTTP **409 busy**; camera unavailable/SafeMode can return **503**. Do not leave a browser stream open while testing the app's camera. Genuine OV2640/OV3660/OV5640 devices with PSRAM use sensor JPEG where initialization permits it; clone sensors can use RGB565-to-JPEG conversion or smaller no-PSRAM fallback frames.

## Local safety and mode validation

The existing firmware defaults remain:

| Behavior | Setting |
|---|---|
| Awareness / warning / danger boundaries | 150 / 100 / 50 cm |
| Zone hysteresis | 15 cm |
| Escalation confirmation | 2 samples after conditioning; de-escalation needs twice the confirmation |
| Distance conditioning | Median of three usable readings |
| Missing usable sonar data | Unknown/fault after 500 ms; does not declare clear |
| HC-SR04 / MPU6050 / INA219 sampling | 60 / 20 / 500 ms |
| Automatic sleep | Disabled by default (`autoSleepMin = 0`) |

Configuration persisted on an existing device can differ from defaults; read `/api/v1/config` rather than assuming a reflash erased NVS. Boundaries and filtering do not establish safe stopping distance for a particular walker.

Run bench trials with the phone disconnected and internet unavailable. Introduce controlled obstacles at known distances and observe local awareness/warning/danger cues. Confirm the motor does not depend on camera inference, Gemini, Firebase, or phone audio. Test sensor disconnection/staleness, motor priority, camera contention, and power stability. In this implementation Unknown stops the obstacle motor pattern and reports a sensor fault; loss of vibration is not proof of a safe path.

SafeMode leaves the camera off while local obstacle/fall processing and telemetry continue. The refined code restores SafeMode warnings/faults and preserves it after wake. Do not intentionally cause watchdog crashes to obtain SafeMode during a user walking trial; use a controlled engineering test.

Explicit Sleep retains its existing suspension of ultrasonic and obstacle motor warnings. It is **not a safe operating mode for assisted walking**. Only test explicit sleep/wake on the bench and verify an unchanged confirmed warning/danger resumes after wake. Camera power requests are deferred behind an owned frame to the existing HTTP task; measure actual contention and transition latency on the board.

Firmware detects falls and publishes local events; the phone owns the configured SOS countdown/delivery. Test fall/SOS with an appropriate fixture and safe test-contact workflow, not by dropping the assembled cane or triggering an unintended emergency message.

## Tests and remaining device evidence

From the repository root with g++ available:

```bash
npm run test:firmware
```

The refinement's recorded result is **64 logic/guard checks and 45 actual-control host checks passed**. The latter compiles real `stick_main.cpp` with external hardware stubs; it covers offline motor requests, SafeMode/staleness, wake behavior, and camera-power integration. It does not execute the ESP32 camera driver, radio, electrical circuit, or actual motor. Target compilation must still be completed using the pinned core above.

Use supervised real-device trials for physical obstacle-to-motor latency, camera capture/inference FPS, stale/dropped frames, reconnect behavior, heap stability, screen-off Android operation, and calibrated INA219 voltage/current/energy. Compare equal-duration runs on the same board/phone/battery with matched conditions; keep phone battery data separate. See [the refinement report](../BATTERY_EFFICIENCY_REFINEMENT_REPORT.md) and [walking guidance report](../WALKING_GUIDANCE_REFINEMENT_REPORT.md).

The confirmed hardware has **one HC-SR04 beam and one camera**. The driver rejects echo durations beyond approximately 4 m. It cannot support a 150 m ultrasonic approach example, measure exact side clearance, certify a human-width bypass corridor, or establish terrain/drop-off/head-height/road-crossing safety. Camera labels and image-relative side hints do not supply calibrated metric depth or world heading. Keep the existing cane technique and supervised validation requirements; do not substitute those unverified claims for missing hardware evidence.

USB upload is the setup path documented here. The presence of OTA endpoints/two OTA slots does not establish a validated secure OTA release process; do not use an unverified OTA path during assistive operation.
