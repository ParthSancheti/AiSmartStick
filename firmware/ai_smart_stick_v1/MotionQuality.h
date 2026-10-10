// AI Smart Stick ECU - Motion Quality Engine
#pragma once
#include <Arduino.h>
#include <math.h>

namespace aiss {

enum class MotionState : uint8_t { STABLE, NORMAL_WALK, SWINGING, RAPID_MOTION, IMPACT, UNKNOWN };
inline const char* motionStateName(MotionState s) {
  switch (s) {
    case MotionState::STABLE: return "STABLE";
    case MotionState::NORMAL_WALK: return "NORMAL_WALK";
    case MotionState::SWINGING: return "SWINGING";
    case MotionState::RAPID_MOTION: return "RAPID_MOTION";
    case MotionState::IMPACT: return "IMPACT";
    default: return "UNKNOWN";
  }
}

struct MotionResult {
  float accMag;
  float linAccMag;
  float gyroMag;
  float jerkMag;
  float pitch;
  float roll;
  MotionState state;
  float motionConfidence;
  float orientationConfidence;
};

class MotionQualityEngine {
public:
  MotionResult update(float ax, float ay, float az, float gx, float gy, float gz, uint32_t now) {
    if (!isfinite(ax) || !isfinite(gx)) {
      return {NAN, NAN, NAN, NAN, NAN, NAN, MotionState::UNKNOWN, 0.0f, 0.0f};
    }
    
    float dt = (lastMs_ == 0) ? 0.02f : (now - lastMs_) / 1000.0f;
    if (dt <= 0.0f) dt = 0.02f;
    if (dt > 1.0f) {
      // Stale or gap, reset some state
      state_ = MotionState::UNKNOWN;
    }
    lastMs_ = now;

    // Magnitudes
    float aMag = sqrtf(ax*ax + ay*ay + az*az);
    float gMag = sqrtf(gx*gx + gy*gy + gz*gz);

    // Gravity estimation (low-pass filter)
    const float alphaG = 0.05f; // dt is ~0.02s
    if (gX_ == 0 && gY_ == 0 && gZ_ == 0) {
      gX_ = ax; gY_ = ay; gZ_ = az;
    } else {
      gX_ = gX_ * (1.0f - alphaG) + ax * alphaG;
      gY_ = gY_ * (1.0f - alphaG) + ay * alphaG;
      gZ_ = gZ_ * (1.0f - alphaG) + az * alphaG;
    }
    
    // Linear acceleration (remove gravity)
    float lx = ax - gX_;
    float ly = ay - gY_;
    float lz = az - gZ_;
    float linMag = sqrtf(lx*lx + ly*ly + lz*lz);

    // Jerk calculation (derivative of acceleration)
    float jx = (ax - lastAx_) / dt;
    float jy = (ay - lastAy_) / dt;
    float jz = (az - lastAz_) / dt;
    float jerk = sqrtf(jx*jx + jy*jy + jz*jz);
    lastAx_ = ax; lastAy_ = ay; lastAz_ = az;

    // Pitch and Roll from Gravity vector (more stable than instantaneous raw accel)
    float pitch = atan2f(-gX_, sqrtf(gY_*gY_ + gZ_*gZ_)) * 57.2958f;
    float roll = atan2f(gY_, gZ_) * 57.2958f;

    // State Machine
    MotionState nextState = state_;
    
    if (aMag > 2.5f || jerk > 100.0f) {
      nextState = MotionState::IMPACT;
      cooldown_ = 1500; // ms
    } else if (cooldown_ > 0) {
      if (dt * 1000.0f <= cooldown_) cooldown_ -= (uint32_t)(dt * 1000.0f);
      else cooldown_ = 0;
      nextState = (state_ == MotionState::IMPACT) ? MotionState::IMPACT : state_; 
      if (cooldown_ == 0) nextState = MotionState::STABLE;
    } else {
      // Normal classification
      if (gMag > 200.0f || linMag > 1.2f) {
        nextState = MotionState::RAPID_MOTION;
      } else if (gMag > 60.0f || linMag > 0.6f) {
        nextState = MotionState::SWINGING;
      } else if (gMag > 15.0f || linMag > 0.15f) {
        nextState = MotionState::NORMAL_WALK;
      } else {
        nextState = MotionState::STABLE;
      }
    }
    
    // Hysteresis/Debounce (avoid rapid flapping)
    if (nextState != pendingState_) {
      pendingState_ = nextState;
      stateTimer_ = 0;
    } else {
      stateTimer_ += (uint32_t)(dt * 1000.0f);
      // Promote state faster for higher-energy states
      uint32_t req = (nextState > state_) ? 40 : 150; 
      if (nextState == MotionState::IMPACT) req = 0;
      if (stateTimer_ >= req) {
        state_ = nextState;
      }
    }

    // Confidences
    // Motion Confidence: 1.0 if not UNKNOWN and data is fresh. Drops if stale.
    float mc = (state_ != MotionState::UNKNOWN) ? 1.0f : 0.0f;
    
    // Orientation Confidence: drops rapidly in high-dynamic situations.
    float oc = 1.0f;
    if (state_ == MotionState::RAPID_MOTION) oc = 0.2f;
    else if (state_ == MotionState::SWINGING) oc = 0.5f;
    else if (state_ == MotionState::IMPACT) oc = 0.0f;
    else if (state_ == MotionState::UNKNOWN) oc = 0.0f;
    else oc = 1.0f - (fminf(linMag, 1.0f) * 0.2f); // Slight drop on pure accel

    return {aMag, linMag, gMag, jerk, pitch, roll, state_, mc, oc};
  }

private:
  uint32_t lastMs_ = 0;
  float gX_ = 0, gY_ = 0, gZ_ = 0;
  float lastAx_ = 0, lastAy_ = 0, lastAz_ = 0;
  MotionState state_ = MotionState::UNKNOWN;
  MotionState pendingState_ = MotionState::UNKNOWN;
  uint32_t stateTimer_ = 0;
  uint32_t cooldown_ = 0;
};

} // namespace aiss
