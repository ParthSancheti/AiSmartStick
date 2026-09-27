#include "Health.h"
#include <esp_system.h>
#include "Ecu.h"

namespace health {
RTC_NOINIT_ATTR static uint32_t rtcMagic;
RTC_NOINIT_ATTR static uint32_t rtcBoots;
RTC_NOINIT_ATTR static uint32_t rtcCrashStreak;
static const char *reason = "unknown";
static bool safe = false;
static bool stableMarked = false;
static uint32_t minHeap = 0xFFFFFFFF;

void init() {
  if (rtcMagic != 0xA155A155) { rtcMagic = 0xA155A155; rtcBoots = 0; rtcCrashStreak = 0; }
  rtcBoots++;
  esp_reset_reason_t r = esp_reset_reason();
  switch (r) {
    case ESP_RST_POWERON: reason = "power_on"; break;
    case ESP_RST_SW: reason = "software"; break;
    case ESP_RST_PANIC: reason = "panic"; break;
    case ESP_RST_INT_WDT: reason = "int_watchdog"; break;
    case ESP_RST_TASK_WDT: reason = "task_watchdog"; break;
    case ESP_RST_WDT: reason = "watchdog"; break;
    case ESP_RST_BROWNOUT: reason = "brownout"; break;
    case ESP_RST_DEEPSLEEP: reason = "deep_sleep"; break;
    default: reason = "other"; break;
  }
  bool crash = r == ESP_RST_PANIC || r == ESP_RST_INT_WDT || r == ESP_RST_TASK_WDT || r == ESP_RST_WDT || r == ESP_RST_BROWNOUT;
  rtcCrashStreak = crash ? rtcCrashStreak + 1 : 0;
  // Do not reboot-loop blindly: after 3 quick crashes start in safe mode (camera off, safety + telemetry only).
  safe = rtcCrashStreak >= 3;
}
const char *resetReason() { return reason; }
uint32_t bootCount() { return rtcBoots; }
bool safeMode() { return safe; }
void markStable() { if (!stableMarked) { rtcCrashStreak = 0; stableMarked = true; } }
uint32_t heapMin() { return minHeap; }
void tick() {
  uint32_t h = ESP.getFreeHeap();
  if (h < minHeap) minHeap = h;
  ecu::setError(ecu::E_HEAP_LOW, h < 30000);
  if (millis() > 60000) markStable();
}
}  // namespace health
