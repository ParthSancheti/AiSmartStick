// Canonical device configuration (mirrors shared/deviceProtocol.ts DeviceConfig).
// Versioned: the app sends setConfig{config.configVersion}; the ECU validates, applies,
// persists to NVS and acknowledges; telemetry health.configVersion echoes what is active.
#pragma once
#include "ArduinoJson.h"
#include "SafetyLogic.h"

struct DeviceConfig {
  uint32_t configVersion = 0;               // 0 = factory defaults
  aiss::ObstacleParams obstacle;            // zones, hysteresis, confirmation
  uint8_t hapticIntensity = 80;             // 0–100 % PWM for feedback/command patterns
  bool obstacleHaptics = true;              // local obstacle vibration (safety) on/off
  aiss::FallParams fall;
  uint16_t autoSleepMin = 0;                // 0 = never; otherwise sleep after N min without motion/button
};

namespace config {
DeviceConfig &active();
void load();                                  // from NVS (defaults if absent/invalid)
bool apply(JsonObjectConst in, String &err);  // validate → apply → persist
void toJson(JsonObject out);
}
