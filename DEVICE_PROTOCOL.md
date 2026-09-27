# AI Smart Stick — device protocol v1 (canonical contract)

**One contract, three implementations kept in lock-step:**

| Side | Location |
|---|---|
| Types | `shared/deviceProtocol.ts` |
| ECU firmware | `firmware/ai_smart_stick_v1/` (Api.cpp, DeviceConfig.cpp, SafetyLogic.h) |
| App transport | `src/core/transport/httpTransport.ts` |

`tests/transport-e2e.test.ts` runs the real app transport against a server that implements this document.
`tests/integration-contracts.test.ts` checks that the app's configuration presets pass the ECU validator.

The legacy prototype endpoints `/data`, `/motor` and `/stream` are **not part of this protocol**. They are
reached only by `LegacyTransport`, from Settings → Hardware test, and labelled "unverified" (see §9).

## 1. Topology and roles
```
Guardian phone ──HTTPS── Firebase / Cloud Functions ──HTTPS── User phone ──HTTP+HMAC (hotspot)── ECU
```
* Only the **User phone** talks to the stick. The Guardian's commands travel through Cloud Functions
  and Firestore to the User phone, which executes them (§7).
* Transport: HTTP/1.1 on the phone's WPA2 hotspot (2.4 GHz), port 80.
* Identity is the HMAC key. The IP address, device name and MAC address are never trusted.

## 2. Device lifecycle
| State | Entered by | ECU behaviour |
|---|---|---|
| Unprovisioned | Factory, or after a reset | Station idle. Safety loop runs. |
| Setup | Holding the button **5 s while unprovisioned** | WPA2 soft AP `AISmartStick-XXXX`; password = 8-character setup code on the label; IP 192.168.4.1 |
| Provisioned | `POST /api/v1/provision` succeeded | Joins the hotspot with exponential backoff (2 → 30 s); signed UDP announcement every 2 s |
| Sleep | `setMode{sleep}` or auto-sleep after N idle minutes | Ultrasonic and camera off. **Any button press wakes it.** |
| Safe mode | 3 crash or watchdog resets, each within 60 s of boot | Camera off; safety loop and telemetry on; `health.mode = "safe"` |
| Factory reset | **Hold the button while powering on** for 5 s | Key, Wi-Fi and configuration erased |

The factory-reset gesture happens only at power-on, so it can never collide with the 3 s SOS hold during use.

## 3. Provisioning (app ↔ ECU on the setup AP)
1. `GET /api/v1/device`: checks `protocolVersion === 1`.
2. `POST /api/v1/provision`:
   ```json
   {"v":1,"ssid":"…","password":"8–63 chars","deviceKey":"<32 random bytes, base64>","ownerHash":"sha256(uid)","nonce":"hex"}
   ```
   The response is `200 {"ok":true,"deviceId","model","firmware","protocolVersion"}`. It returns
   `400 bad_request` for invalid credentials or key, and `409 provision_failed` if the stick is not in
   setup mode.
3. The ECU leaves AP mode 1.5 s later and joins the hotspot.
4. The app waits for a signed announcement, then the challenge proof (§4).

Full user flow: PAIRING_FLOW.md.

## 4. Authentication
Every endpoint except `/device` and `/provision` requires these headers:
```
x-aiss-device  AISS-XXXXXX
x-aiss-ts      phone wall clock (ms)
x-aiss-nonce   ≥16 hex chars, random
x-aiss-sig     hex HMAC-SHA256(key, METHOD \n path?query \n ts \n nonce \n hex SHA256(body))
```
The ECU rejects a request with `401 unauthorized` when:
* the device id is wrong,
* the signature is bad,
* the nonce is one of the last 32 accepted, or
* `ts` is more than 30 s older than the newest accepted `ts`.

**Stick proof:** `GET /api/v1/device?challenge=<hex>` returns `proof = HMAC(key, challenge + deviceId)`.
The app verifies it on every (re)connect. A mismatch gives link state `auth_failed`, which is terminal
until the user re-pairs.

**Version check:** if `protocolVersion ≠ 1`, the link state becomes `protocol_mismatch` (terminal, "Update firmware").

**Discovery** is a UDP broadcast to port 4210:
`{"v":1,"deviceId","ip","port":80,"uptimeMs","sig":HMAC(deviceId+ip+uptimeMs)}`.
Unsigned or mis-signed announcements are ignored.

## 5. Device → App messages
### 5.1 Telemetry: `GET /api/v1/telemetry` (P4, polled every ~300 ms)
| Field | Type | Notes |
|---|---|---|
| `v`, `deviceId`, `seq`, `uptimeMs` | int, string, int, int | `seq` increases within a boot; a lower `uptimeMs` means the stick rebooted (the app resets its filters) |
| `battery` | `{busV, shuntMv, currentMa, powerMw, charging, chargeSource, ok}` | **Raw** INA219 values. `charging` is `null` unless a STAT pin is wired. The app estimates charge (one algorithm, `BatteryEstimator`) |
| `imu` | `{ax, ay, az (g), gx, gy, gz (°/s), pitch, roll (°), ok}` | ±8 g range |
| `ultrasonic` | `{distanceCm, echoUs, status, sampleAgeMs, zone}` | `status`: ok, no_echo, out_of_range, invalid, timeout, error. `zone`: unknown, normal, awareness, warning, danger. The zone is **decided on the ECU** |
| `button[]` | `{id, kind: press/release/gesture, gesture?, atMs}` | Last 5 s, at most 16 events. The app de-duplicates by `id` and classifies gestures (§8) |
| `safety[]` | `{id, type: fall/obstacle/sensor_fault, atMs, value, confidence}` | Last 10 s. `fall` carries confidence 0–1 |
| `rssi` | dBm | |
| `health` | see 5.2 | |

Any number may be `null` (sensor failed). The ECU never sends NaN or Infinity. The app rejects a packet
(`validatePacket`) when it has:
* a bad shape or an unknown enum,
* a distance outside 0–1000 cm,
* a bus voltage outside 0–30 V,
* an angle outside ±180°,
* more than 32 button events,
* a malformed device id, or
* a body over 16 KB.

A rejected packet never reaches any store.

### 5.2 Health: `GET /api/v1/status`, and `telemetry.health`
`{camera, i2c, motor, heapFree, heapMin, psramFree, resetReason, bootCount, mode, configVersion, firmware, wifi, errors[]}`
* `resetReason` is one of: power_on, software, panic, int_watchdog, task_watchdog, watchdog, brownout, deep_sleep, other.
* `errors[]` codes: camera_init, camera_capture, i2c, imu, ina219, ultrasonic_stale, wifi, heap_low, config.
* The app shows a `degraded` link when `errors[]` is not empty or latency exceeds 1.2 s.

### 5.3 Camera: `GET /api/v1/capture` (P3, on request only)
* Returns `image/jpeg` with headers `x-aiss-width`, `x-aiss-height`, `x-aiss-seq` and `x-aiss-ts`.
* Errors: `409 busy`, and `503 camera_error` (safe mode, init failure, or 3 failures followed by a re-init).
* The app validates the JPEG markers and size before use.

### 5.4 Configuration: `GET /api/v1/config`
Returns the active `DeviceConfig` (§6.2).

## 6. App → Device messages
### 6.1 Command envelope: `POST /api/v1/command`
```json
{"commandId":"c…","type":"haptic","payload":{"pattern":"confirm","intensity":60},"issuedAt":1766…,"expiresAt":1766…}
```
The response is **always a `CommandAck`**:

`{"commandId","status":"completed|failed|rejected|expired|duplicate","error"?,"result"?}`

* **Idempotent:** the ECU remembers the last 24 ids. A repeat returns `duplicate` and is **not executed again**.
  The app retries once with the same id; Guardian relays reuse the Firestore command id.
* **Bounded:** `expiresAt` is compared with the request's `x-aiss-ts`. A late command is answered `expired`.
* **Transport errors:** `400 bad_request` for malformed JSON or a missing id, `413` for a body over 1 KB,
  `401 unauthorized`.

| type | payload | Effect / result |
|---|---|---|
| `haptic` | `pattern`: tap, confirm, warning, danger, sos, locate, nudge; `intensity` 0–100 (optional) | Named patterns only (the app never sends raw timings). **Never interrupts an active safety pattern** (ack `failed`) |
| `locate` / `nudge` | — | Find-stick or nudge pattern |
| `setConfig` | `config: DeviceConfig` | Validate → apply → persist to NVS → `result.configVersion`. `rejected` if invalid or not newer |
| `getConfig` | — | `result` = active configuration |
| `setMode` | `mode`: normal or sleep | Sleep / wake |
| `selfTest` | — | Returns imu, battery, ultrasonic, a camera capture (bytes), a motor pulse, heap, psram and reset reason |
| `calibrateImu` | — | The upright zero is applied in the app (ack `completed` with a note) |
| `reboot` / `factoryReset` | — | Executed 300 ms after the ack |

### 6.3 Over-The-Air Firmware Update: `POST /api/v1/ota`
Pushes a new firmware binary to the ECU.
* Request body: binary firmware image.
* Authenticated using standard device protocol headers (HMAC).
* The SHA-256 of the binary must be included in the canonical request for the HMAC signature.
* On success, the stick will verify, write to the OTA partition, switch boot partition, and reboot.

### 6.2 DeviceConfig (one model for app settings and ECU)
```json
{"configVersion":1790498055,
 "obstacle":{"enabled":true,"awarenessCm":150,"warningCm":100,"dangerCm":50,"hysteresisCm":15,"confirmSamples":2},
 "haptics":{"intensity":80,"obstacleAlerts":true},
 "fall":{"enabled":true,"impactG":2.5,"freeFallG":0.45,"tiltDeg":55,"inactivityMs":2000},
 "power":{"autoSleepMin":0}}
```
**Validation:**
* obstacle: 20 ≤ danger < warning < awareness ≤ 350; hysteresis 5–50; confirmSamples 1–6
* haptics intensity 0–100; autoSleep 0–240
* fall: impact 1.5–8 g, tilt 30–90°, inactivity 0.5–10 s

**Sync:** after every (re)connect and every settings change, the app sends `setConfig` with
`configVersion = max(now in seconds, active + 1)`. The UI says "Applied on the stick" **only after the
ack**. Telemetry `health.configVersion` echoes what is active.

## 7. Guardian remote commands (through the backend)
1. The Guardian calls `sendRemoteCommand{type: locate|nudge|scan}`.
2. The function checks the relationship and permission, applies a rate limit of 6/min, and writes
   `users/{uid}/deviceCommands/{id}` with `expiresAt` = +2 min.
3. The User phone's relay moves the command through the states
   `queued → received → executing → completed | failed | expired`.
   For `locate` and `nudge` it sends the device command with `commandId = id`.
   For `scan` it runs vision and returns **text only**.
4. The Guardian watches the document to see the outcome.

**The Guardian cannot trigger or cancel an SOS remotely** (policy).

## 8. Button semantics (one interpreter: `ButtonClassifier`, device timestamps)
| Gesture | Where it is decided | Action |
|---|---|---|
| Single press | App | Talk to the assistant. Cancels an SOS countdown; ends a call |
| Double press | App | "Where am I?" (GPS + reverse geocode) |
| Triple press | App | "What's in front of me?" (capture + vision + fusion) |
| Hold 3 s | App starts the SOS countdown. The **ECU buzzes the SOS pattern locally at 3 s**, so the press is felt as registered even if the phone is slow | SOS (if enabled) |
| Hold 5 s while unprovisioned | ECU | Setup AP |
| Hold while powering on 5 s | ECU | Factory reset |

## 9. Safety boundary
The obstacle path is **ultrasonic → median-of-3 → zone state machine (thresholds, hysteresis,
temporal confirmation, stale → unknown) → motor**, entirely on the ECU.

It never waits for the phone, Wi-Fi, Firebase or Gemini. The phone only mirrors the zone. When the zone
becomes `danger` the phone also speaks a P0 warning, which interrupts other speech.

Fall detection also runs on the ECU (free fall → impact → tilt versus the learned upright → stillness).
The app turns `safety[].type == "fall"` into the SOS countdown only if the user enabled fall SOS.
Gemini never decides either.

## 10. Legacy prototype (compatibility only)
`LegacyTransport` reads `/data` (distance_cm, pitch, roll, button_state, is_charging), `/motor` and
the first JPEG of `/stream`. It is:
* unauthenticated,
* never paired,
* never shown as "Connected", and
* never used to show `battery_pct`.

It exists so an old prototype board can be bench-checked. Production uses §1–§8 only.
