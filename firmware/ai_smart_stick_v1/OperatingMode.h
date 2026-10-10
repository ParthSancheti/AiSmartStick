// Local safety policy shared by the ECU and host regression tests.
#pragma once
#include <stdint.h>

namespace ecu {
enum class Mode : uint8_t { Normal, Sleep, Setup, SafeMode };

inline bool localSafetyActive(Mode mode) {
  return mode == Mode::Normal || mode == Mode::SafeMode;
}

// A camera crash recovery boot must remain camera-free when the user wakes it.
inline Mode normalModeAfterWake(bool safeMode) {
  return safeMode ? Mode::SafeMode : Mode::Normal;
}
}  // namespace ecu
