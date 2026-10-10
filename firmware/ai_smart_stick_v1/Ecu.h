// AI Smart Stick ECU — shared state between the control loop (P0–P2, Arduino loop task)
// and the HTTP task (P3 camera, P4 telemetry). All cross-task access goes through snapshot()
// or the event queues, each guarded by a short critical section.
#pragma once
#include <Arduino.h>
#include "BoardConfig.h"
#include "SafetyLogic.h"
#include "OperatingMode.h"

namespace ecu {

inline const char *modeName(Mode m) { return m == Mode::Sleep ? "sleep" : m == Mode::Setup ? "setup" : m == Mode::SafeMode ? "safe" : "normal"; }

struct Sensors {
  // Battery (INA219, raw)
  bool batOk = false;
  float busV = NAN, shuntMv = NAN, currentMa = NAN, powerMw = NAN;
  int8_t charging = -1;          // -1 unknown (no STAT pin), 0/1 from STAT pin
  // IMU (MPU6050, raw + tilt)
  bool imuOk = false;
  float ax = NAN, ay = NAN, az = NAN, gx = NAN, gy = NAN, gz = NAN, pitch = NAN, roll = NAN;
  // Ultrasonic (raw + ECU zone)
  const char *usStatus = "error";
  float usCm = NAN;
  uint32_t echoUs = 0;
  uint32_t usSampleAt = 0;
  aiss::Zone zone = aiss::Zone::Unknown;
  // Health
  bool i2cOk = false;
  bool camOk = false;
  bool camBusy = false;
  bool motorRunning = false;
  Mode mode = Mode::Normal;
};

struct EventRec {
  uint32_t id;
  uint8_t kind;       // 0 press, 1 release, 2 gesture(setup)
  uint32_t atMs;
};

struct SafetyRec {
  uint32_t id;
  uint8_t type;       // 0 fall, 1 obstacle (danger entered), 2 sensor_fault
  uint32_t atMs;
  float value;
  float confidence;
};

void setSensors(const Sensors &s);
Sensors snapshot();
void pushButton(uint8_t kind, uint32_t atMs);
void pushSafety(uint8_t type, float value, float confidence);
/** Copies events newer than (now - windowMs); the app de-duplicates by id. Returns count. */
int recentButtons(EventRec *out, int max, uint32_t windowMs);
int recentSafety(SafetyRec *out, int max, uint32_t windowMs);

// Errors (codes, not free text) reported in health.errors
enum Err : uint16_t { E_CAMERA_INIT = 1, E_CAMERA_CAPTURE = 2, E_I2C = 4, E_IMU = 8, E_INA = 16, E_US_STALE = 32, E_WIFI = 64, E_HEAP_LOW = 128, E_CONFIG = 256 };
void setError(uint16_t bit, bool on);
uint16_t errors();

}  // namespace ecu
