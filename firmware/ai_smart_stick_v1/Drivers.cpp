#include "Drivers.h"
#include <Wire.h>
#include "Ecu.h"

// ═════════════════════════ Motor ═════════════════════════
namespace motor {
struct Pat { const char *name; const uint16_t *steps; uint8_t n; };
// on, off, on, off … (ms)
static const uint16_t S_TAP[] = {60};
static const uint16_t S_CONFIRM[] = {80, 80, 80};
static const uint16_t S_WARNING[] = {150, 100, 150};
static const uint16_t S_DANGER[] = {400, 120, 400};
static const uint16_t S_SOS[] = {200, 100, 200, 100, 200, 300, 500, 100, 500, 100, 500, 300, 200, 100, 200, 100, 200};
static const uint16_t S_LOCATE[] = {300, 200, 300, 200, 300, 200, 300, 200, 300};
static const uint16_t S_NUDGE[] = {120, 120, 120};
// Safety zone patterns (repeat while the zone is active)
static const uint16_t S_ZONE_AWARE[] = {50, 1400};
static const uint16_t S_ZONE_WARN[] = {140, 460};
static const uint16_t S_ZONE_DANGER[] = {260, 90};
static const uint16_t S_FALL[] = {600, 200, 600};
static const Pat PATS[] = {
  {"tap", S_TAP, 1}, {"confirm", S_CONFIRM, 3}, {"warning", S_WARNING, 3}, {"danger", S_DANGER, 3},
  {"sos", S_SOS, sizeof(S_SOS) / 2}, {"locate", S_LOCATE, sizeof(S_LOCATE) / 2}, {"nudge", S_NUDGE, 3},
  {"zone_awareness", S_ZONE_AWARE, 2}, {"zone_warning", S_ZONE_WARN, 2}, {"zone_danger", S_ZONE_DANGER, 2}, {"fall", S_FALL, 3},
};

static const Pat *cur = nullptr;
static Priority curPrio = COMMAND;
static bool rep = false;
static uint8_t idx = 0, dutyPct = 80, curDuty = 80;
static uint32_t nextAt = 0;

static void out(bool on) {
  uint32_t duty = on ? (uint32_t)((1 << MOTOR_PWM_BITS) - 1) * curDuty / 100 : 0;
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_MOTOR, duty);
#else
  ledcWrite(MOTOR_PWM_CH, duty);
#endif
}

void begin() {
  pinMode(PIN_MOTOR, OUTPUT);
  digitalWrite(PIN_MOTOR, LOW);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_MOTOR, MOTOR_PWM_HZ, MOTOR_PWM_BITS);
#else
  ledcSetup(MOTOR_PWM_CH, MOTOR_PWM_HZ, MOTOR_PWM_BITS);
  ledcAttachPin(PIN_MOTOR, MOTOR_PWM_CH);
#endif
  out(false);
}
void setIntensity(uint8_t pct) { dutyPct = pct > 100 ? 100 : pct; }
bool knownPattern(const char *p) { for (auto &x : PATS) if (!strcmp(x.name, p)) return true; return false; }

bool play(const char *pattern, Priority prio, bool repeat, uint8_t intensityPct) {
  const Pat *p = nullptr;
  for (auto &x : PATS) if (!strcmp(x.name, pattern)) p = &x;
  if (!p) return false;
  if (cur && prio < curPrio) return false;          // never interrupt a higher-priority (safety) pattern
  if (cur == p && rep && repeat) return true;         // already running
  cur = p; curPrio = prio; rep = repeat; idx = 0;
  // Safety patterns are never weaker than 60 % even if the user lowered feedback strength.
  curDuty = intensityPct ? intensityPct : (prio == SAFETY ? (dutyPct < 60 ? 60 : dutyPct) : dutyPct);
  nextAt = millis() + p->steps[0];
  out(true);
  return true;
}
void stop(Priority prio) {
  if (!cur || prio < curPrio) return;
  cur = nullptr; out(false);
}
void tick() {
  if (!cur || (int32_t)(millis() - nextAt) < 0) return;
  idx++;
  if (idx >= cur->n) {
    if (rep) idx = 0;
    else { cur = nullptr; out(false); return; }
  }
  out(idx % 2 == 0);
  nextAt = millis() + cur->steps[idx];
}
bool running() { return cur != nullptr; }
}  // namespace motor

// ═════════════════════════ Ultrasonic ═════════════════════════
namespace ultrasonic {
static volatile uint32_t rise = 0, width = 0;
static volatile bool done = false;
static uint32_t trigAt = 0;
static bool waiting = false, enabled = true;

static void IRAM_ATTR isr() {
  if (digitalRead(PIN_US_ECHO)) rise = micros();
  else { width = micros() - rise; done = true; }
}
void begin() {
  pinMode(PIN_US_TRIG, OUTPUT);
  digitalWrite(PIN_US_TRIG, LOW);
  pinMode(PIN_US_ECHO, INPUT);   // external divider holds it LOW when idle
  attachInterrupt(digitalPinToInterrupt(PIN_US_ECHO), isr, CHANGE);
}
void setEnabled(bool on) { enabled = on; }
Sample tick() {
  Sample s{false, 2, NAN, 0, "error"};
  uint32_t now = millis();
  if (waiting && done) {
    done = false; waiting = false;
    uint32_t us = width;
    s.fresh = true; s.echoUs = us;
    if (us < 115) { s.kind = 2; s.status = "invalid"; }                 // < 2 cm
    else if (us > 23500) { s.kind = 1; s.status = "out_of_range"; }     // > ~400 cm
    else { s.kind = 0; s.cm = us / 58.0f; s.status = "ok"; }
  } else if (waiting && now - trigAt > US_ECHO_TIMEOUT_MS) {
    waiting = false;
    s.fresh = true; s.kind = 1; s.status = "no_echo";
  }
  if (enabled && !waiting && now - trigAt >= US_PERIOD_MS) {
    // 10 µs trigger: the only busy-wait in the firmware (bounded, 10 µs).
    digitalWrite(PIN_US_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_US_TRIG, LOW);
    trigAt = now; waiting = true; done = false;
  }
  return s;
}
}  // namespace ultrasonic

// ═════════════════════════ I2C sensors ═════════════════════════
static bool i2cRead(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)addr, (int)n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}
static bool i2cWrite(uint8_t addr, uint8_t reg, uint8_t v) {
  Wire.beginTransmission(addr); Wire.write(reg); Wire.write(v);
  return Wire.endTransmission() == 0;
}
static bool wireStarted = false;
static void wireBegin() {
  if (wireStarted) return;
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_HZ);
  Wire.setTimeOut(15);   // a stuck bus can never stall the safety loop for long
  wireStarted = true;
}

namespace imu {
static bool present = false;
bool begin() {
  wireBegin();
  uint8_t who = 0;
  present = i2cRead(MPU6050_ADDR, 0x75, &who, 1) && (who == 0x68 || who == 0x70 || who == 0x72) &&  // WHO_AM_I (MPU6050/6500 clones)
            i2cWrite(MPU6050_ADDR, 0x6B, 0x00) && i2cWrite(MPU6050_ADDR, 0x1A, 0x03) &&                // wake, DLPF 44 Hz
            i2cWrite(MPU6050_ADDR, 0x1C, 0x10) && i2cWrite(MPU6050_ADDR, 0x1B, 0x00);                 // ±8 g (impacts), ±250 °/s
  ecu::setError(ecu::E_IMU, !present);
  return present;
}
Reading read() {
  Reading r{false, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN};
  uint8_t b[14];
  if (!present && !begin()) return r;
  if (!i2cRead(MPU6050_ADDR, 0x3B, b, 14)) { present = false; ecu::setError(ecu::E_IMU, true); return r; }
  auto w = [&](int i) { return (int16_t)((b[i] << 8) | b[i + 1]); };
  r.ax = w(0) / 4096.0f; r.ay = w(2) / 4096.0f; r.az = w(4) / 4096.0f;   // ±8 g → 4096 LSB/g
  r.gx = w(8) / 131.0f; r.gy = w(10) / 131.0f; r.gz = w(12) / 131.0f;
  r.pitch = atan2f(-r.ax, sqrtf(r.ay * r.ay + r.az * r.az)) * 57.2958f;
  r.roll = atan2f(r.ay, r.az) * 57.2958f;
  r.ok = true;
  ecu::setError(ecu::E_IMU, false);
  return r;
}
}  // namespace imu

namespace battery {
static bool present = false;
bool begin() {
  wireBegin();
  uint8_t b[2];
  present = i2cRead(INA219_ADDR, 0x00, b, 2);   // default config: 32 V range, ±320 mV shunt, 12-bit
  ecu::setError(ecu::E_INA, !present);
  return present;
}
Reading read() {
  Reading r{false, NAN, NAN, NAN, NAN, -1};
  uint8_t b[2];
  if (!present && !begin()) return r;
  if (!i2cRead(INA219_ADDR, 0x02, b, 2)) { present = false; ecu::setError(ecu::E_INA, true); return r; }
  uint16_t bus = (b[0] << 8) | b[1];
  if (bus & 0x01) { /* math overflow flag: reading invalid */ return r; }
  r.busV = (bus >> 3) * 0.004f;
  if (!i2cRead(INA219_ADDR, 0x01, b, 2)) { present = false; return r; }
  r.shuntMv = (int16_t)((b[0] << 8) | b[1]) * 0.01f;
  r.currentMa = r.shuntMv / INA219_SHUNT_OHM;   // + = discharging when wired battery → load (verify, see HARDWARE_WIRING.md)
  r.powerMw = r.busV * r.currentMa;
#if PIN_CHARGE_STAT >= 0
  r.charging = digitalRead(PIN_CHARGE_STAT) == LOW ? 1 : 0;
#endif
  r.ok = true;
  ecu::setError(ecu::E_INA, false);
  return r;
}
}  // namespace battery

// ═════════════════════════ Button ═════════════════════════
namespace button {
static bool state = false, raw = false;
static uint32_t changeAt = 0, pressAt = 0;
void begin() { pinMode(PIN_BUTTON, INPUT_PULLUP); }
int tick() {
  bool r = digitalRead(PIN_BUTTON) == LOW;
  uint32_t now = millis();
  if (r != raw) { raw = r; changeAt = now; }
  if (raw != state && now - changeAt >= BTN_DEBOUNCE_MS) {
    state = raw;
    if (state) { pressAt = now; return 1; }
    return 2;
  }
  return 0;
}
bool down() { return state; }
uint32_t heldMs() { return state ? millis() - pressAt : 0; }
}  // namespace button

// ═════════════════════════ Camera ═════════════════════════
namespace camera {
static bool inited = false;
static uint8_t failures = 0;
bool begin() {
  camera_config_t c = {};
  c.pin_pwdn = CAM_PWDN; c.pin_reset = CAM_RESET; c.pin_xclk = CAM_XCLK; c.pin_sccb_sda = CAM_SIOD; c.pin_sccb_scl = CAM_SIOC;
  c.pin_d7 = CAM_Y9; c.pin_d6 = CAM_Y8; c.pin_d5 = CAM_Y7; c.pin_d4 = CAM_Y6; c.pin_d3 = CAM_Y5; c.pin_d2 = CAM_Y4; c.pin_d1 = CAM_Y3; c.pin_d0 = CAM_Y2;
  c.pin_vsync = CAM_VSYNC; c.pin_href = CAM_HREF; c.pin_pclk = CAM_PCLK;
  c.xclk_freq_hz = 20000000; c.ledc_timer = LEDC_TIMER_0; c.ledc_channel = LEDC_CHANNEL_0;
  c.pixel_format = PIXFORMAT_JPEG;      // the sensor encodes; no RGB→JPEG conversion on the CPU
  c.frame_size = FRAMESIZE_VGA;         // 640×480 is enough for vision; bounded memory
  c.jpeg_quality = 12;
  c.fb_count = psramFound() ? 2 : 1;
  c.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;     // never serve a stale buffered frame
  inited = esp_camera_init(&c) == ESP_OK;
  ecu::setError(ecu::E_CAMERA_INIT, !inited);
  failures = 0;
  return inited;
}
bool ok() { return inited; }
camera_fb_t *capture() {
  if (!inited) return nullptr;
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb || fb->format != PIXFORMAT_JPEG || fb->len < 1000) {
    if (fb) esp_camera_fb_return(fb);
    ecu::setError(ecu::E_CAMERA_CAPTURE, true);
    if (++failures >= 3) { esp_camera_deinit(); inited = false; begin(); }   // recover instead of rebooting
    return nullptr;
  }
  failures = 0;
  ecu::setError(ecu::E_CAMERA_CAPTURE, false);
  return fb;
}
void release(camera_fb_t *fb) { if (fb) esp_camera_fb_return(fb); }
void powerDown() { if (inited) { esp_camera_deinit(); inited = false; } pinMode(CAM_PWDN, OUTPUT); digitalWrite(CAM_PWDN, HIGH); }
void powerUp() { if (!inited) { digitalWrite(CAM_PWDN, LOW); begin(); } }
}  // namespace camera
