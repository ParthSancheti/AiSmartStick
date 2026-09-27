// AI Smart Stick ECU — deterministic safety logic (pure C++, no Arduino dependencies).
// Host-tested: firmware/tests/test_safety.cpp  (g++ -std=c++17 ... && ./a.out)
//
// The obstacle path is LOCAL: sensor → filter → zone FSM → motor. It never waits for the phone,
// Wi-Fi, Firebase or Gemini.
#pragma once
#include <stdint.h>
#include <math.h>

namespace aiss {

enum class Zone : uint8_t { Unknown = 0, Normal = 1, Awareness = 2, Warning = 3, Danger = 4 };

inline const char *zoneName(Zone z) {
  switch (z) {
    case Zone::Normal: return "normal";
    case Zone::Awareness: return "awareness";
    case Zone::Warning: return "warning";
    case Zone::Danger: return "danger";
    default: return "unknown";
  }
}

struct ObstacleParams {
  bool enabled = true;
  uint16_t awarenessCm = 150;
  uint16_t warningCm = 100;
  uint16_t dangerCm = 50;
  uint16_t hysteresisCm = 15;   // leave a zone only when farther than threshold + hysteresis
  uint8_t confirmSamples = 2;   // consecutive samples to ESCALATE (de-escalation needs 2×)
  uint16_t staleMs = 500;       // no usable sample for this long → Unknown (sensor fault)
};

/** Validates a parameter set; returns false (and leaves out untouched) if inconsistent. */
inline bool validObstacleParams(const ObstacleParams &p) {
  return p.dangerCm >= 20 && p.dangerCm < p.warningCm && p.warningCm < p.awarenessCm && p.awarenessCm <= 350 &&
         p.hysteresisCm >= 5 && p.hysteresisCm <= 50 && p.confirmSamples >= 1 && p.confirmSamples <= 6 && p.staleMs >= 200 && p.staleMs <= 3000;
}

/**
 * Obstacle zone state machine.
 *  - median-of-3 on valid readings (single spikes never trigger),
 *  - invalid readings (<2 cm, NaN) are ignored, they do not count as "clear",
 *  - "no echo" counts as far (nothing in range) for DE-escalation only,
 *  - escalation needs `confirmSamples` consecutive agreeing samples,
 *  - de-escalation needs 2 × confirmSamples AND distance beyond threshold + hysteresis,
 *  - no usable sample for `staleMs` → Unknown (reported as a sensor fault, motor off).
 */
class ObstacleFsm {
 public:
  void setParams(const ObstacleParams &p) { params_ = p; }
  const ObstacleParams &params() const { return params_; }
  Zone zone() const { return zone_; }
  float filteredCm() const { return filtered_; }

  // kind: 0 = valid distance, 1 = no echo / out of range, 2 = invalid/error
  Zone update(int kind, float cm, uint32_t nowMs) {
    if (!params_.enabled) { zone_ = Zone::Normal; pending_ = Zone::Normal; count_ = 0; lastUsable_ = nowMs; return zone_; }
    float d;
    if (kind == 0 && isfinite(cm) && cm >= 2.0f && cm <= 450.0f) {
      push(cm);
      d = median();
    } else if (kind == 1) {
      n_ = 0;               // nothing in range: reset the median window
      d = 9999.0f;
    } else {
      if ((uint32_t)(nowMs - lastUsable_) > params_.staleMs) { zone_ = Zone::Unknown; count_ = 0; }
      return zone_;
    }
    lastUsable_ = nowMs;
    filtered_ = d;
    Zone target = classify(d);
    if (target == zone_) { pending_ = target; count_ = 0; return zone_; }
    if (target != pending_) { pending_ = target; count_ = 0; }
    count_++;
    bool escalate = rank(target) > rank(zone_);
    uint8_t need = escalate ? params_.confirmSamples : (uint8_t)(params_.confirmSamples * 2);
    if (zone_ == Zone::Unknown) need = params_.confirmSamples;
    if (count_ >= need) { zone_ = target; count_ = 0; }
    return zone_;
  }

 private:
  static int rank(Zone z) { return z == Zone::Unknown ? 0 : (int)z; }

  // Hysteresis: entering a more severe zone uses the threshold; staying in the current zone
  // is allowed until the distance exceeds threshold + hysteresis.
  Zone classify(float d) const {
    const ObstacleParams &p = params_;
    const float h = p.hysteresisCm;
    auto limit = [&](Zone z) -> float {
      float t = z == Zone::Danger ? p.dangerCm : z == Zone::Warning ? p.warningCm : z == Zone::Awareness ? p.awarenessCm : 0;
      return (rank(zone_) >= rank(z)) ? t + h : t;
    };
    if (d < limit(Zone::Danger)) return Zone::Danger;
    if (d < limit(Zone::Warning)) return Zone::Warning;
    if (d < limit(Zone::Awareness)) return Zone::Awareness;
    return Zone::Normal;
  }

  void push(float v) {
    win_[idx_ % 3] = v;
    idx_++;
    if (n_ < 3) n_++;
  }
  float median() const {
    if (n_ == 1) return win_[(idx_ - 1) % 3];
    if (n_ == 2) return (win_[(idx_ - 1) % 3] + win_[(idx_ - 2) % 3]) / 2.0f;
    float a = win_[0], b = win_[1], c = win_[2];
    return fmaxf(fminf(a, b), fminf(fmaxf(a, b), c));
  }

  ObstacleParams params_;
  Zone zone_ = Zone::Unknown;
  Zone pending_ = Zone::Unknown;
  uint8_t count_ = 0;
  float win_[3] = {0, 0, 0};
  uint32_t idx_ = 0;
  uint8_t n_ = 0;
  float filtered_ = -1;
  uint32_t lastUsable_ = 0;
};

// ─────────────────────────────────────────────────────────────────────────────

struct FallParams {
  bool enabled = true;
  float freeFallG = 0.45f;      // |a| below this = free fall
  uint16_t freeFallMs = 70;     // sustained for at least this long
  float impactG = 2.5f;         // |a| above this = impact
  uint16_t impactWindowMs = 1000;
  float tiltDeg = 55.0f;        // device orientation change vs. the upright reference
  uint16_t inactivityMs = 2000; // low motion after the impact
  float stillBandG = 0.25f;     // |a| within 1 ± band counts as still
};

inline bool validFallParams(const FallParams &p) {
  return p.freeFallG > 0.1f && p.freeFallG < 0.9f && p.impactG >= 1.5f && p.impactG <= 8.0f && p.tiltDeg >= 30 && p.tiltDeg <= 90 &&
         p.inactivityMs >= 500 && p.inactivityMs <= 10000 && p.freeFallMs >= 20 && p.freeFallMs <= 500;
}

struct FallResult {
  bool detected;
  float confidence;   // 0..1
  float peakG;
};

/**
 * Fall detector: free fall (optional) → impact → large orientation change → stillness.
 * A single noisy spike is never a fall: it needs the whole temporal pattern.
 * Confidence: impact 0.5 (+0.2 preceded by free fall) (+0.15 tilt beyond 1.3× threshold) (+0.15 long stillness).
 */
class FallDetector {
 public:
  void setParams(const FallParams &p) { p_ = p; }

  FallResult update(float ax, float ay, float az, uint32_t now) {
    FallResult none{false, 0, 0};
    if (!p_.enabled) { state_ = Idle; return none; }
    float g = sqrtf(ax * ax + ay * ay + az * az);
    if (!isfinite(g) || g > 16.0f) return none;
    switch (state_) {
      case Idle:
        // Learn the upright reference slowly while the stick is calm.
        if (fabsf(g - 1.0f) < 0.1f) {
          const float k = 0.02f;
          rx_ += k * (ax - rx_); ry_ += k * (ay - ry_); rz_ += k * (az - rz_);
          haveRef_ = true;
        }
        if (g < p_.freeFallG) { state_ = FreeFall; t0_ = now; }
        else if (g > p_.impactG * 1.3f) { toImpact(now, g, false); }
        break;
      case FreeFall:
        if (g < p_.freeFallG) break;
        if (now - t0_ >= p_.freeFallMs) { state_ = AwaitImpact; t0_ = now; freeFall_ = true; }
        else state_ = Idle;  // too short: noise
        // fallthrough check for immediate impact on the same sample
        if (state_ == AwaitImpact && g > p_.impactG) toImpact(now, g, true);
        break;
      case AwaitImpact:
        if (g > p_.impactG) toImpact(now, g, true);
        else if (now - t0_ > p_.impactWindowMs) state_ = Idle;
        break;
      case Settling:
        if (g > peak_) peak_ = g;
        if (now - t0_ >= 400) { state_ = Still; stillSince_ = now; }
        break;
      case Still: {
        if (fabsf(g - 1.0f) > p_.stillBandG) { stillSince_ = now; if (now - t0_ > 6000) state_ = Idle; break; }
        if (now - stillSince_ >= p_.inactivityMs) {
          float tilt = tiltDeg(ax, ay, az);
          state_ = Cooldown; t0_ = now;
          if (tilt >= p_.tiltDeg) {
            float c = 0.5f + (freeFall_ ? 0.2f : 0.0f) + (tilt >= p_.tiltDeg * 1.3f ? 0.15f : 0.0f) + (now - stillSince_ >= (uint32_t)p_.inactivityMs * 2 ? 0.15f : 0.0f);
            return FallResult{true, c > 1.0f ? 1.0f : c, peak_};
          }
        }
        break;
      }
      case Cooldown:
        if (now - t0_ > 5000) state_ = Idle;
        break;
    }
    return none;
  }

  float tiltDeg(float ax, float ay, float az) const {
    if (!haveRef_) return 0;
    float dot = ax * rx_ + ay * ry_ + az * rz_;
    float n = sqrtf(ax * ax + ay * ay + az * az) * sqrtf(rx_ * rx_ + ry_ * ry_ + rz_ * rz_);
    if (n < 1e-3f) return 0;
    float c = dot / n;
    if (c > 1) c = 1;
    if (c < -1) c = -1;
    return acosf(c) * 57.29578f;
  }

  void setReference(float ax, float ay, float az) { rx_ = ax; ry_ = ay; rz_ = az; haveRef_ = true; }

 private:
  enum State : uint8_t { Idle, FreeFall, AwaitImpact, Settling, Still, Cooldown };
  void toImpact(uint32_t now, float g, bool ff) { state_ = Settling; t0_ = now; peak_ = g; freeFall_ = ff; }

  FallParams p_;
  State state_ = Idle;
  uint32_t t0_ = 0, stillSince_ = 0;
  float peak_ = 0;
  bool freeFall_ = false;
  float rx_ = 0, ry_ = 0, rz_ = 1;
  bool haveRef_ = false;
};

// ─────────────────────────────────────────────────────────────────────────────

/** Command idempotency: remembers the last N command ids; a repeat is acknowledged as "duplicate". */
template <int N>
class IdRing {
 public:
  bool seen(const char *id) const {
    for (int i = 0; i < N; i++) if (ids_[i][0] && eq(ids_[i], id)) return true;
    return false;
  }
  void add(const char *id) {
    char *d = ids_[next_++ % N];
    int i = 0;
    for (; id[i] && i < 39; i++) d[i] = id[i];
    d[i] = 0;
  }
 private:
  static bool eq(const char *a, const char *b) {
    int i = 0;
    for (; a[i] && b[i]; i++) if (a[i] != b[i]) return false;
    return a[i] == b[i];
  }
  char ids_[N][40] = {};
  unsigned next_ = 0;
};

}  // namespace aiss
