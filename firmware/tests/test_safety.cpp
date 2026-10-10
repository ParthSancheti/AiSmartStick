// Host tests for the ECU safety logic. Run: g++ -std=c++17 -O1 -I../ai_smart_stick_v1 test_safety.cpp -o t && ./t
#include <cstdio>
#include <cstdlib>
#include "SafetyLogic.h"
#include "OperatingMode.h"
#include "CameraAccess.h"
#include "BoardConfig.h"
using namespace aiss;

static int fails = 0, passes = 0;
#define CHECK(c) do { if (c) passes++; else { fails++; std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #c); } } while (0)

static Zone feed(ObstacleFsm &f, float cm, uint32_t &t, int n = 1, int kind = 0) {
  Zone z = Zone::Unknown;
  for (int i = 0; i < n; i++) { t += 60; z = f.update(kind, cm, t); }
  return z;
}

int main() {
  // 1. Escalation needs confirmation; a single spike does not vibrate.
  { ObstacleFsm f; uint32_t t = 0;
    CHECK(feed(f, 300, t, 3) == Zone::Normal);
    CHECK(feed(f, 30, t, 1) == Zone::Normal);           // one spike (median-of-3 rejects it)
    CHECK(feed(f, 300, t, 2) == Zone::Normal);
    CHECK(feed(f, 40, t, 4) == Zone::Danger); }          // sustained → danger

  // 2. Hysteresis: no chatter around the danger threshold.
  { ObstacleFsm f; uint32_t t = 0;
    feed(f, 40, t, 5);
    CHECK(f.zone() == Zone::Danger);
    int changes = 0; Zone prev = f.zone();
    for (int i = 0; i < 40; i++) { Zone z = feed(f, (i % 2) ? 48 : 58, t); if (z != prev) changes++; prev = z; }  // noise around 50 cm
    CHECK(changes == 0);
    CHECK(feed(f, 80, t, 6) == Zone::Warning); }         // clearly beyond 50+15 → leaves danger (after 2× confirmation)

  // 3. Zones.
  { ObstacleFsm f; uint32_t t = 0;
    CHECK(feed(f, 130, t, 4) == Zone::Awareness);
    CHECK(feed(f, 90, t, 4) == Zone::Warning);
    CHECK(feed(f, 400, t, 1, 1) == Zone::Warning);        // one "no echo" is not enough to de-escalate
    CHECK(feed(f, 400, t, 6, 1) == Zone::Normal); }        // sustained nothing-in-range → normal

  // 4. Invalid readings are ignored and eventually become Unknown (sensor fault), never "safe".
  { ObstacleFsm f; uint32_t t = 0;
    feed(f, 200, t, 3);
    CHECK(f.zone() == Zone::Normal);
    CHECK(feed(f, 0, t, 3, 2) == Zone::Normal);           // 180 ms of invalid: still within staleMs
    CHECK(feed(f, 0, t, 10, 2) == Zone::Unknown); }       // > 500 ms → unknown

  // 5. Params validation.
  { ObstacleParams p; CHECK(validObstacleParams(p));
    p.dangerCm = 120; CHECK(!validObstacleParams(p)); }

  // 6. Disabled → no alerts.
  { ObstacleFsm f; ObstacleParams p; p.enabled = false; f.setParams(p); uint32_t t = 0;
    CHECK(feed(f, 20, t, 5) == Zone::Normal); }

  // 7. Fall: free fall → impact → tilt → stillness = fall with high confidence.
  { FallDetector d; uint32_t t = 0; FallResult r{false, 0, 0};
    for (int i = 0; i < 100; i++) { t += 20; d.update(0, 0, 1, t); }          // upright reference
    for (int i = 0; i < 6; i++) { t += 20; d.update(0, 0, 0.1f, t); }          // 120 ms free fall
    t += 20; d.update(0, 3.2f, 0.5f, t);                                        // impact
    for (int i = 0; i < 200 && !r.detected; i++) { t += 20; r = d.update(0.98f, 0.1f, 0.1f, t); }  // lying on its side, still
    CHECK(r.detected);
    CHECK(r.confidence >= 0.8f); }

  // 8. A hard tap (impact) while staying upright is NOT a fall.
  { FallDetector d; uint32_t t = 0; bool any = false;
    for (int i = 0; i < 100; i++) { t += 20; d.update(0, 0, 1, t); }
    t += 20; d.update(0, 0, 4.0f, t);
    for (int i = 0; i < 300; i++) { t += 20; any |= d.update(0, 0.02f, 1.0f, t).detected; }
    CHECK(!any); }

  // 9. Noise spikes without the pattern are ignored.
  { FallDetector d; uint32_t t = 0; bool any = false;
    for (int i = 0; i < 500; i++) { t += 20; float z = (i % 37 == 0) ? 0.3f : 1.0f; any |= d.update(0, 0, z, t).detected; }
    CHECK(!any); }

  // 10. Command id ring (idempotency).
  { IdRing<4> r; r.add("c1"); r.add("c2"); CHECK(r.seen("c1")); CHECK(!r.seen("c3"));
    r.add("c3"); r.add("c4"); r.add("c5"); CHECK(!r.seen("c1")); CHECK(r.seen("c5")); }

  // 11. A camera crash recovery boot preserves independent local safety and cannot wake its camera.
  { CHECK(ecu::localSafetyActive(ecu::Mode::Normal));
    CHECK(ecu::localSafetyActive(ecu::Mode::SafeMode));
    CHECK(!ecu::localSafetyActive(ecu::Mode::Sleep));
    CHECK(!ecu::localSafetyActive(ecu::Mode::Setup));
    CHECK(ecu::normalModeAfterWake(false) == ecu::Mode::Normal);
    CHECK(ecu::normalModeAfterWake(true) == ecu::Mode::SafeMode); }

  // 12. Preserve approach thresholds, filtering, confirmation and sensor timing. An abrupt
  // obstacle in this synthetic 60 ms trace enters Danger on the third close sample (not the first).
  { ObstacleFsm f; uint32_t t = 0;
    CHECK(f.params().awarenessCm == 150 && f.params().warningCm == 100 && f.params().dangerCm == 50);
    CHECK(f.params().hysteresisCm == 15 && f.params().confirmSamples == 2 && f.params().staleMs == 500);
    CHECK(US_PERIOD_MS == 60 && IMU_PERIOD_MS == 20 && INA_PERIOD_MS == 500);
    CHECK(feed(f, 300, t, 5) == Zone::Normal);
    CHECK(feed(f, 30, t) == Zone::Normal);
    CHECK(feed(f, 30, t) == Zone::Normal);
    CHECK(feed(f, 30, t) == Zone::Danger);
    CHECK(ecu::localSafetyActive(ecu::Mode::SafeMode) && f.zone() == Zone::Danger);
    t += 501;
    CHECK(f.update(2, NAN, t) == Zone::Unknown); }

  // 13. A held camera frame blocks other captures and all power transitions. A pending mode
  // request then blocks new captures until the frame has been returned and power work runs.
  { CameraAccess a; CameraAccess::Power power = CameraAccess::Power::None;
    CHECK(a.tryCapture());
    CHECK(!a.tryCapture());
    a.requestPower(false);
    CHECK(!a.powerChangeReady());
    CHECK(!a.tryPowerChange(power));
    CHECK(!a.tryCapture());
    a.release();
    CHECK(a.powerChangeReady());
    CHECK(!a.tryCapture());
    CHECK(a.tryPowerChange(power));
    CHECK(power == CameraAccess::Power::Down);
    CHECK(!a.tryCapture());
    a.release();
    CHECK(!a.powerChangeReady());
    CHECK(a.tryCapture());
    a.release(); }

  // 14. Fast sleep/wake changes coalesce to the newest pending request. If posting HTTP work
  // fails, the guard keeps the request ready for a later attempt rather than dropping it.
  { CameraAccess a; CameraAccess::Power power = CameraAccess::Power::None;
    a.requestPower(false);
    a.requestPower(true);
    CHECK(a.powerChangeReady());
    CHECK(a.powerChangeReady()); // failed scheduling leaves the guard untouched
    CHECK(a.tryPowerChange(power));
    CHECK(power == CameraAccess::Power::Up);
    CHECK(!a.powerChangeReady());
    CHECK(!a.tryPowerChange(power));
    // A sleep request arriving during initialization must remain pending after it finishes.
    a.requestPower(false);
    CHECK(!a.powerChangeReady());
    a.release();
    CHECK(a.powerChangeReady());
    CHECK(!a.tryCapture());
    CHECK(a.tryPowerChange(power));
    CHECK(power == CameraAccess::Power::Down);
    a.release();
    CHECK(a.tryCapture());
    a.release(); }

  std::printf("%d passed, %d failed\n", passes, fails);
  return fails ? 1 : 0;
}
