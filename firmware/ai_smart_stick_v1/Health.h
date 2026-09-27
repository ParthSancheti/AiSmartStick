// Reset reason, boot-loop protection (safe mode) and heap watermarks.
#pragma once
#include <Arduino.h>
namespace health {
void init();                 // call first in setup()
const char *resetReason();
uint32_t bootCount();
bool safeMode();             // true after 3 crash/watchdog resets within 60 s of boot each
void markStable();           // call once the device has run 60 s: clears the crash streak
uint32_t heapMin();
void tick();
}
