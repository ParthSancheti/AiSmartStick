// AI Smart Stick reference firmware — board & pin configuration.
// !!! These pins are a PROPOSAL for the AI-Thinker ESP32-CAM. They were NOT taken from your wiring
// (the test firmware was not supplied). Verify every pin against FIRMWARE_AUDIT.md before powering up.
#pragma once

#define FW_VERSION        "1.0.0-ref"
#define DEVICE_MODEL      "AISS-ESP32CAM-1"
#define PROTOCOL_VERSION  1

// ── Free pins on AI-Thinker ESP32-CAM when the camera is used and the SD card is NOT ──
// GPIO 2, 4, 12, 13, 14, 15 (+1/3 if serial is not needed). GPIO 16 = PSRAM (never use).
#define PIN_I2C_SDA       15   // MPU6050 (0x68) + INA219 (0x40) share this bus. Strapping pin: must not be pulled LOW at boot.
#define PIN_I2C_SCL       14
#define PIN_US_TRIG       13   // HC-SR04 trigger (3.3 V is enough for TRIG)
#define PIN_US_ECHO       2    // HC-SR04 echo is 5 V: MUST go through a divider (e.g. 1k/2k) to 3.3 V. Strapping pin: LOW at boot (HC-SR04 idles LOW).
#define PIN_MOTOR         12   // Vibration motor via logic-level MOSFET/NPN + flyback diode. Strapping (flash voltage): needs a 10k pull-DOWN.
#define PIN_BUTTON        4    // Button to GND with INPUT_PULLUP. GPIO4 also drives the flash LED: remove/disable the LED transistor or move the button.
#define PIN_CHARGE_STAT   -1   // Optional charger STAT pin (e.g. TP4056 CHRG). -1 = not wired → app infers charging from current.

// INA219 shunt (ohms). Most breakout boards use 0.1 Ω.
#define INA219_SHUNT_OHM  0.1f
#define INA219_ADDR       0x40
#define MPU6050_ADDR      0x68

#define SETUP_HOLD_MS     5000   // unprovisioned: hold 5 s → setup AP
#define RESET_HOLD_MS     10000  // provisioned: hold 10 s → factory reset (erase Wi-Fi + key) → setup AP
#define DISCOVERY_PORT    4210
#define OBSTACLE_WARN_CM  100    // local vibration works without the phone
#define OBSTACLE_DANGER_CM 50
