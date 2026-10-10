// Minimal external Arduino API for executing the real ECU control loop on the host.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <math.h>
#include <string>
using String = std::string;
constexpr int LOW = 0, HIGH = 1;
namespace test_hw {
inline uint32_t nowMs = 0;
inline bool restarted = false;
}
inline uint32_t millis() { return test_hw::nowMs; }
inline int digitalRead(int) { return HIGH; }
inline void delay(uint32_t ms) { test_hw::nowMs += ms; }
struct HostSerial {
  void begin(int) {}
  void println(const char *) {}
  template <class... Args> void printf(const char *, Args...) {}
};
inline HostSerial Serial;
struct HostEsp { void restart() { test_hw::restarted = true; } };
inline HostEsp ESP;
