// AI Smart Stick ECU — board configuration (AI-Thinker ESP32-CAM, OV2640, 4 MB PSRAM).
//
// CANONICAL WIRING = the owner's current prototype wiring, audited in HARDWARE_WIRING.md:
//   TRIG=13  ECHO=12  MOTOR=2  BUTTON=3  SDA=14  SCL=15
// It is ACCEPTABLE ONLY with the electrical conditions below. The firmware does not "work around"
// an unsafe circuit; if a condition cannot be met, change the wiring (see HARDWARE_WIRING.md §4).
#pragma once
#include <stdint.h>

#define FW_VERSION        "1.2.0"
#define DEVICE_MODEL      "AISS-ESP32CAM-1"
#define PROTOCOL_VERSION  1

// ── Stick link (v1 = simple) ─────────────────────────────────────────────────
// The stick is always its own Wi-Fi access point. Any phone that joins it reads telemetry and sends
// commands WITHOUT keys or signatures (REQUIRE_AUTH 0). The Wi-Fi password is the only protection.
// Set REQUIRE_AUTH to 1 to bring back the HMAC-signed requests of firmware 1.1 (the app would then
// need the old provisioning flow again).
#define REQUIRE_AUTH      0
#define STICK_AP_SSID     "SmartStick_AI"
#define STICK_AP_PASS     "Stick@1234"
#define STICK_AP_CHANNEL  6        // 1/6/11 are the non-overlapping 2.4 GHz channels
#define STICK_AP_MAX_STA  4        // phones that may join at once

// ── HC-SR04 ──────────────────────────────────────────────────────────────────
#define PIN_US_TRIG   13   // 3.3 V trigger is sufficient for HC-SR04.
#define PIN_US_ECHO   12   // !! ECHO is 5 V: a divider (1 kΩ series / 2 kΩ to GND) or level shifter is MANDATORY.
                           // !! GPIO12 = MTDI strap: HIGH at reset selects 1.8 V flash → boot failure/brownout.
                           //    Echo idles LOW, so boot is normally fine; recommended: burn the flash-voltage eFuse
                           //    once (espefuse.py set_flash_voltage 3.3V) so GPIO12 can never break boot.
// ── Vibration motor ──────────────────────────────────────────────────────────
#define PIN_MOTOR     2    // Drive a logic-level N-MOSFET/NPN (never the motor directly) + flyback diode.
                           // GPIO2 = strap (must be LOW/floating to enter download mode): add a 10 kΩ pull-down on the gate.
// ── Button ───────────────────────────────────────────────────────────────────
#define PIN_BUTTON    3    // U0RXD. Button to GND, INPUT_PULLUP. Serial RX is given up at runtime (logs still on TX/GPIO1).
                           // Do not hold the button while flashing over serial.
// ── I2C (MPU6050 0x68, INA219 0x40) ─────────────────────────────────────────
#define PIN_I2C_SDA   14
#define PIN_I2C_SCL   15   // GPIO15 = MTDO strap; the I2C pull-up keeps it HIGH at reset (default = fine).
#define I2C_HZ        400000
#define MPU6050_ADDR  0x68
#define INA219_ADDR   0x40
#define INA219_SHUNT_OHM 0.1f
// Optional charger STAT (TP4056 CHRG, open-drain, LOW while charging). -1 = not wired → app infers charging.
#define PIN_CHARGE_STAT -1

// ── Camera: AI-Thinker OV2640 mapping (fixed by the board) ──────────────────
#define CAM_PWDN 32
#define CAM_RESET -1
#define CAM_XCLK 0
#define CAM_SIOD 26
#define CAM_SIOC 27
#define CAM_Y9 35
#define CAM_Y8 34
#define CAM_Y7 39
#define CAM_Y6 36
#define CAM_Y5 21
#define CAM_Y4 19
#define CAM_Y3 18
#define CAM_Y2 5
#define CAM_VSYNC 25
#define CAM_HREF 23
#define CAM_PCLK 22

// ── Motor PWM ────────────────────────────────────────────────────────────────
#define MOTOR_PWM_CH   2        // LEDC channels 0/1 (timer 0) belong to the camera XCLK.
#define MOTOR_PWM_HZ   5000
#define MOTOR_PWM_BITS 8

// ── Timing (P0 safety loop) ──────────────────────────────────────────────────
#define US_PERIOD_MS        60     // HC-SR04 ranging period (≈16 Hz, no echo overlap)
#define US_ECHO_TIMEOUT_MS  38     // > 400 cm round trip
#define IMU_PERIOD_MS       20     // 50 Hz for fall detection
#define INA_PERIOD_MS       500
#define HEALTH_PERIOD_MS    1000
#define DISCOVERY_PERIOD_MS 2000
#define DISCOVERY_PORT      4210

// ── Button gestures handled on the ECU ───────────────────────────────────────
#define BTN_DEBOUNCE_MS     25
#define BTN_SOS_FEEDBACK_MS 3000   // local haptic confirmation that the SOS hold registered (app runs the countdown)
#define BTN_SETUP_HOLD_MS   5000   // unprovisioned only: enter setup AP
#define BOOT_RESET_HOLD_MS  5000   // factory reset: hold the button WHILE powering on (never during normal use)
