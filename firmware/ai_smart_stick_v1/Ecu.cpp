#include "Ecu.h"

namespace ecu {
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static Sensors cur;
static EventRec btnQ[16];
static SafetyRec safQ[8];
static uint32_t btnN = 0, safN = 0, btnId = 0, safId = 0;
static uint16_t errBits = 0;

void setSensors(const Sensors &s) { portENTER_CRITICAL(&mux); cur = s; portEXIT_CRITICAL(&mux); }
Sensors snapshot() { portENTER_CRITICAL(&mux); Sensors s = cur; portEXIT_CRITICAL(&mux); return s; }

void pushButton(uint8_t kind, uint32_t atMs) {
  portENTER_CRITICAL(&mux);
  btnQ[btnN++ % 16] = {++btnId, kind, atMs};
  portEXIT_CRITICAL(&mux);
}
void pushSafety(uint8_t type, float value, float confidence) {
  portENTER_CRITICAL(&mux);
  safQ[safN++ % 8] = {++safId, type, millis(), value, confidence};
  portEXIT_CRITICAL(&mux);
}
int recentButtons(EventRec *out, int max, uint32_t windowMs) {
  int n = 0;
  uint32_t now = millis();
  portENTER_CRITICAL(&mux);
  for (int i = 0; i < 16 && n < max; i++) if (btnQ[i].id && now - btnQ[i].atMs <= windowMs) out[n++] = btnQ[i];
  portEXIT_CRITICAL(&mux);
  return n;
}
int recentSafety(SafetyRec *out, int max, uint32_t windowMs) {
  int n = 0;
  uint32_t now = millis();
  portENTER_CRITICAL(&mux);
  for (int i = 0; i < 8 && n < max; i++) if (safQ[i].id && now - safQ[i].atMs <= windowMs) out[n++] = safQ[i];
  portEXIT_CRITICAL(&mux);
  return n;
}
void setError(uint16_t bit, bool on) { portENTER_CRITICAL(&mux); errBits = on ? (errBits | bit) : (errBits & ~bit); portEXIT_CRITICAL(&mux); }
uint16_t errors() { portENTER_CRITICAL(&mux); uint16_t e = errBits; portEXIT_CRITICAL(&mux); return e; }
}  // namespace ecu
