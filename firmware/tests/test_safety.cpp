// Host tests for the ECU safety logic. Run: g++ -std=c++17 -O1 -I../ai_smart_stick_v1 test_safety.cpp -o t && ./t
#include <cstdio>
#include <cstdlib>
#include "SafetyLogic.h"
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

  std::printf("%d passed, %d failed\n", passes, fails);
  return fails ? 1 : 0;
}
