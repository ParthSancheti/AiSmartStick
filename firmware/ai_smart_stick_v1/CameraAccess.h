// Nonblocking ownership for camera frames and deferred power transitions.
// Capture callers keep ownership through JPEG conversion, sending, and frame return.
#pragma once
#include <atomic>
#include <stdint.h>

namespace aiss {
class CameraAccess {
 public:
  enum class Power : uint32_t { None, Up, Down };

  bool tryCapture() {
    if (pendingPower_.load() != Power::None) return false;
    if (!tryOwn()) return false;
    // A mode change may have arrived between the first check and acquiring ownership.
    if (pendingPower_.load() != Power::None) { release(); return false; }
    return true;
  }

  void requestPower(bool on) { pendingPower_.store(on ? Power::Up : Power::Down); }

  bool powerChangeReady() const {
    return pendingPower_.load() != Power::None && busy_.load() == 0;
  }

  bool tryPowerChange(Power &power) {
    if (!powerChangeReady() || !tryOwn()) return false;
    power = pendingPower_.exchange(Power::None);
    if (power == Power::None) { release(); return false; }
    return true;
  }

  void release() { busy_.store(0); }

 private:
  bool tryOwn() {
    uint32_t free = 0;
    return busy_.compare_exchange_strong(free, 1);
  }
  // ESP32's native compare-and-swap operates on a 32-bit word.
  std::atomic<uint32_t> busy_{0};
  std::atomic<Power> pendingPower_{Power::None};
};
}  // namespace aiss
