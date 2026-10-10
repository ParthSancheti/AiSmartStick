// AI Smart Stick ECU — hardware drivers (non-blocking; no delay(), no pulseIn()).
#pragma once
#include <Arduino.h>
#include <esp_camera.h>
#include "BoardConfig.h"

// ── Motor: PWM intensity + pattern state machine with priorities ─────────────
namespace motor {
enum Priority : uint8_t { COMMAND = 0, FEEDBACK = 1, SAFETY = 2 };
void begin();
void setIntensity(uint8_t pct);                                        // for COMMAND/FEEDBACK patterns
/** Plays a named semantic pattern. Lower priority never interrupts higher. Returns false if rejected. */
bool play(const char *pattern, Priority prio, bool repeat = false, uint8_t intensityPct = 0);
void stop(Priority prio);                                              // stops only if the current pattern ≤ prio
/** Blocking buzz for boot-time feedback only (before loop() runs tick()). */
void pulse(uint16_t ms);
void tick();
bool running();
bool knownPattern(const char *pattern);
}

// ── HC-SR04 via echo interrupt ───────────────────────────────────────────────
namespace ultrasonic {
struct Sample { bool fresh; int kind; float cm; uint32_t echoUs; const char *status; };  // kind: 0 ok, 1 no echo/out of range, 2 invalid
void begin();
Sample tick();          // triggers on schedule; returns fresh=true when a new measurement completed
void setEnabled(bool on);
}

// ── MPU6050 / INA219 on I2C ──────────────────────────────────────────────────
namespace imu {
struct Reading { bool ok; float ax, ay, az, gx, gy, gz, pitch, roll; };
bool begin();
Reading read();
}
namespace battery {
struct Reading { bool ok; float busV, shuntMv, currentMa, powerMw; int8_t charging; };
bool begin();
Reading read();
}

// ── Button (debounced edges; long-hold timing exposed) ───────────────────────
namespace button {
void begin();
/** Returns 0 none, 1 pressed edge, 2 released edge. */
int tick();
/** Ignore the button until it is released once (a hold that started at power-on is not a press). */
void suppressUntilRelease();
bool down();
uint32_t heldMs();
}

// ── Camera lifecycle: IDLE → CAPTURE → SEND → RELEASE ─────────────────────────
namespace camera {
bool begin();
bool ok();
/** Nonblocking shared guard for API captures, streams, self-test, and power changes. */
bool tryLock();
void unlock();
/** Sensor JPEG on OV2640/OV3660/OV5640, RGB565 on other sensors (serve via toJpeg).
 *  Caller MUST call release(fb). Re-initialises after repeated failures. */
camera_fb_t *capture();
bool jpeg();
uint16_t sensorPid();
void release(camera_fb_t *fb);
/** RGB565 frame -> JPEG (caller free()s *out). Works with and without PSRAM. */
bool toJpeg(camera_fb_t *fb, uint8_t **out, size_t *len);
/** Records a mode change; expensive initialization/deinitialization runs in the HTTP task. */
void requestPower(bool on);
bool powerChangeReady();
void applyPendingPower();
}
