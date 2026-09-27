# Hardware wiring and electrical audit (AI-Thinker ESP32-CAM)

Status: **the owner's wiring is adopted as canonical, on conditions.** None of it has been measured
by us. Every item marked ⚠ must be verified on the bench before the product is called safe.

## 1. Pin map (firmware/ai_smart_stick_v1/BoardConfig.h)
| Function | GPIO | Audit result | Required electrical condition |
|---|---|---|---|
| HC-SR04 TRIG | 13 | ✅ Free pin, output | None (3.3 V is enough to trigger) |
| HC-SR04 ECHO | 12 | ⚠ **Strap pin (MTDI, flash voltage).** Echo is **5 V** | **Voltage divider mandatory:** 1 kΩ in series, 2 kΩ to GND (≈3.3 V), or a level shifter. Echo must be LOW at reset (it idles LOW). **Recommended:** burn the flash-voltage eFuse once (`espefuse.py --port X set_flash_voltage 3.3V`), after which GPIO12 can never cause a 1.8 V-flash boot failure |
| Vibration motor | 2 | ⚠ Strap pin (must be LOW or floating to enter download mode); also SD D0 | **Never drive the motor from the pin.** Use a logic-level N-MOSFET (e.g. AO3400) or NPN, a **flyback diode** across the motor, a **10 kΩ pull-down** gate→GND (motor off during boot and flash), and about 100 Ω in series to the gate. PWM runs at 5 kHz on LEDC channel 2 (the camera owns channels 0/1) |
| Button | 3 | ⚠ **U0RXD** | Button to GND, internal pull-up (add an external 10 kΩ to 3.3 V for noise). Serial **RX** is unusable at runtime (logs still go out on TX/GPIO1). **Do not hold the button while flashing.** If the boards are reworked, prefer GPIO13 or 14 and move TRIG/SDA accordingly |
| I2C SDA | 14 | ✅ | 4.7 kΩ pull-ups to 3.3 V (most MPU6050/INA219 breakouts have them; with both boards the parallel value must stay ≥ 2.2 kΩ) |
| I2C SCL | 15 | ⚠ Strap (MTDO) | The pull-up keeps it HIGH at reset, which is the correct default |
| Camera | 0, 5, 18, 19, 21–23, 25–27, 32, 34–36, 39 | ✅ Fixed AI-Thinker map | Do not use these for anything else. GPIO16 is PSRAM chip select and must **never** be used. GPIO4 drives the flash LED and is unused |
| Charger STAT (optional) | — | Not wired | If the TP4056 CHRG pin is wired (open drain) to a free input, set `PIN_CHARGE_STAT`; charging then becomes "hardware" instead of "inferred" |

**Why the wiring is not changed silently:** the pins are electrically usable *with* the conditions
above. If any condition cannot be met (no divider, motor driven directly, button pressed at boot), change
the wiring. Do not rely on the firmware to compensate.

## 2. Sensors
* **MPU6050 (0x68):** 3.3 V supply. The firmware checks WHO_AM_I (0x68/0x70/0x72 clones), uses ±8 g
  (impacts) and a 44 Hz DLPF. ⚠ Mount it rigidly; loose mounting defeats fall detection.
* **INA219 (0x40):** must sit **high-side on the battery**, so it measures the cell and not the 5 V
  boost output. ⚠ Confirm the shunt (R100 = 0.1 Ω) and polarity: current must read positive when
  discharging, otherwise flip `BATTERY_CONFIG.currentSign` in the app. The bus voltage must read about
  3.0–4.2 V; about 5 V means it is on the wrong rail (the app shows "sensor error").
* **HC-SR04:** 5 V supply, echo through the divider. The ultrasonic cone is about 15°, so the sensor
  sees the **centre only**. That is why fusion ranges only centre objects. ⚠ Aim it slightly downward
  along the walking direction and verify the zones on a real kerb, wall and doorway.

## 3. Power architecture (verify before any claim)
* **Single-cell Li-ion** → protection (DW01 + FS8205, or a protected cell) → TP4056 charger → a
  **5 V boost of at least 2 A** for the ESP32-CAM 5 V pin and the HC-SR04, with the motor on the boost
  output through its MOSFET.
* **Brownout risk:** camera capture plus Wi-Fi TX peaks draw about 400–500 mA, and the motor starts at
  about 100–200 mA. Add **470–1000 µF** low-ESR bulk plus 100 nF at the ESP32-CAM 5 V pin and at the
  motor. `health.resetReason = "brownout"` in telemetry is the field symptom.
* Never feed the battery directly to the 3.3 V pin.

## 4. Mechanical robustness (not validated)
* Strain-relief every connector (vibration and impacts).
* Protect the camera lens with a window.
* Recess the button so it is not pressed accidentally when the stick is laid down.
* Keep the charging port sealed or covered.
* Keep sensor alignment fixed.
* **No waterproofing is claimed.** Splash tests are required.

## 5. Bench checks (record results in PRODUCTION_CHECKLIST.md)
1. Scope the ECHO pin: at most 3.4 V high.
2. GPIO2 and GPIO12 are LOW at reset.
3. The motor is off during flashing.
4. The board boots 20 times in a row, from battery and from USB.
5. Capture plus motor plus Wi-Fi together for 10 min with no brownout reset.
6. INA219 current sign and voltage match a multimeter within 1 %.
7. I2C scan finds 0x68 and 0x40.
