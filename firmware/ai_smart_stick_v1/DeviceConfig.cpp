#include "DeviceConfig.h"
#include <Preferences.h>
#include "Ecu.h"

namespace config {
static DeviceConfig cfg;
DeviceConfig &active() { return cfg; }

void toJson(JsonObject o) {
  o["configVersion"] = cfg.configVersion;
  JsonObject ob = o["obstacle"].to<JsonObject>();
  ob["enabled"] = cfg.obstacle.enabled;
  ob["awarenessCm"] = cfg.obstacle.awarenessCm;
  ob["warningCm"] = cfg.obstacle.warningCm;
  ob["dangerCm"] = cfg.obstacle.dangerCm;
  ob["hysteresisCm"] = cfg.obstacle.hysteresisCm;
  ob["confirmSamples"] = cfg.obstacle.confirmSamples;
  JsonObject h = o["haptics"].to<JsonObject>();
  h["intensity"] = cfg.hapticIntensity;
  h["obstacleAlerts"] = cfg.obstacleHaptics;
  JsonObject f = o["fall"].to<JsonObject>();
  f["enabled"] = cfg.fall.enabled;
  f["impactG"] = cfg.fall.impactG;
  f["freeFallG"] = cfg.fall.freeFallG;
  f["tiltDeg"] = cfg.fall.tiltDeg;
  f["inactivityMs"] = cfg.fall.inactivityMs;
  JsonObject p = o["power"].to<JsonObject>();
  p["autoSleepMin"] = cfg.autoSleepMin;
}

bool apply(JsonObjectConst in, String &err) {
  DeviceConfig next = cfg;
  if (!in["configVersion"].is<uint32_t>()) { err = "configVersion required"; return false; }
  next.configVersion = in["configVersion"];
  if (next.configVersion <= cfg.configVersion && cfg.configVersion != 0) { err = "stale configVersion"; return false; }
  JsonObjectConst ob = in["obstacle"];
  if (!ob.isNull()) {
    next.obstacle.enabled = ob["enabled"] | next.obstacle.enabled;
    next.obstacle.awarenessCm = ob["awarenessCm"] | next.obstacle.awarenessCm;
    next.obstacle.warningCm = ob["warningCm"] | next.obstacle.warningCm;
    next.obstacle.dangerCm = ob["dangerCm"] | next.obstacle.dangerCm;
    next.obstacle.hysteresisCm = ob["hysteresisCm"] | next.obstacle.hysteresisCm;
    next.obstacle.confirmSamples = ob["confirmSamples"] | next.obstacle.confirmSamples;
  }
  JsonObjectConst h = in["haptics"];
  if (!h.isNull()) {
    int i = h["intensity"] | (int)next.hapticIntensity;
    if (i < 0 || i > 100) { err = "haptics.intensity out of range"; return false; }
    next.hapticIntensity = i;
    next.obstacleHaptics = h["obstacleAlerts"] | next.obstacleHaptics;
  }
  JsonObjectConst f = in["fall"];
  if (!f.isNull()) {
    next.fall.enabled = f["enabled"] | next.fall.enabled;
    next.fall.impactG = f["impactG"] | next.fall.impactG;
    next.fall.freeFallG = f["freeFallG"] | next.fall.freeFallG;
    next.fall.tiltDeg = f["tiltDeg"] | next.fall.tiltDeg;
    next.fall.inactivityMs = f["inactivityMs"] | next.fall.inactivityMs;
  }
  JsonObjectConst p = in["power"];
  if (!p.isNull()) {
    int m = p["autoSleepMin"] | (int)next.autoSleepMin;
    if (m < 0 || m > 240) { err = "power.autoSleepMin out of range"; return false; }
    next.autoSleepMin = m;
  }
  if (!aiss::validObstacleParams(next.obstacle)) { err = "invalid obstacle thresholds"; return false; }
  if (!aiss::validFallParams(next.fall)) { err = "invalid fall parameters"; return false; }
  cfg = next;
  // Persist as JSON (small, versioned, human-readable in diagnostics).
  JsonDocument d;
  toJson(d.to<JsonObject>());
  String s;
  serializeJson(d, s);
  Preferences p2;
  p2.begin("aiss-cfg", false);
  p2.putString("json", s);
  p2.end();
  return true;
}

void load() {
  Preferences p;
  p.begin("aiss-cfg", true);
  String s = p.getString("json", "");
  p.end();
  if (!s.length()) return;
  JsonDocument d;
  if (deserializeJson(d, s)) { ecu::setError(ecu::E_CONFIG, true); return; }
  String err;
  uint32_t v = d["configVersion"] | 0;
  cfg.configVersion = 0;  // allow re-applying the stored version
  if (!apply(d.as<JsonObjectConst>(), err)) { cfg = DeviceConfig(); ecu::setError(ecu::E_CONFIG, true); }
  (void)v;
}
}  // namespace config
