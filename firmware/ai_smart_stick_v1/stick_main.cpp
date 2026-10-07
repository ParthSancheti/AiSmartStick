/*
 * AI Smart Stick ECU — control loop (protocol v1, DEVICE_PROTOCOL.md).
 *
 * Scheduling (Arduino loop task, core 1; HTTP/camera/Wi-Fi run on core 0):
 *   P0 SAFETY     every iteration: ultrasonic → ObstacleFsm → motor; IMU → FallDetector; button
 *   P1 USER INPUT button edges → event queue; SOS-hold haptic confirmation; setup/sleep/wake
 *   P2 HEALTH     battery (500 ms), heap/errors (1 s), Wi-Fi reconnect/backoff, discovery
 *   P3 CAMERA     only on request, in the HTTP task (never blocks P0)
 *   P4 TELEMETRY  pulled by the phone every ~300 ms from the HTTP task (snapshot copy)
 * No delay()/pulseIn() in the loop; the only busy-wait is the 10 µs ultrasonic trigger.
 * UNTESTED ON HARDWARE — compile-checked and logic host-tested (firmware/tests).
 */
#include <Arduino.h>
#include <WiFi.h>
#include <esp_task_wdt.h>
#include "BoardConfig.h"
#include "SafetyLogic.h"
#include "DeviceConfig.h"
#include "Drivers.h"
#include "Ecu.h"
#include "Identity.h"
#include "Net.h"
#include "Api.h"
#include "Health.h"

static aiss::ObstacleFsm obstacle;
static aiss::FallDetector fall;
static ecu::Sensors S;
static aiss::Zone lastZone = aiss::Zone::Unknown;
static uint32_t lastActivity = 0, lastSosFeedbackPress = 0, leaveApAt = 0, rebootAt = 0;
static uint32_t cfgApplied = 0xFFFFFFFF;

static void applyConfig() {
  const DeviceConfig &c = config::active();
  obstacle.setParams(c.obstacle);
  fall.setParams(c.fall);
  motor::setIntensity(c.hapticIntensity);
  cfgApplied = c.configVersion;
}

static void setMode(ecu::Mode m) {
  if (S.mode == m) return;
  S.mode = m;
  if (m == ecu::Mode::Sleep) {
    ultrasonic::setEnabled(false);
    motor::stop(motor::SAFETY);
    camera::powerDown();
  } else if (m == ecu::Mode::Normal) {
    ultrasonic::setEnabled(true);
    if (!health::safeMode()) camera::powerUp();
    motor::play("confirm", motor::FEEDBACK);
  }
}

// P0: obstacle zone → motor (local, deterministic, no network involved)
static void safetyZone(aiss::Zone z) {
  if (z == lastZone) return;
  const bool alerts = config::active().obstacleHaptics && S.mode == ecu::Mode::Normal;
  if (z == aiss::Zone::Danger) {
    if (alerts) motor::play("zone_danger", motor::SAFETY, true);
    ecu::pushSafety(1, obstacle.filteredCm(), 1.0f);
  } else if (z == aiss::Zone::Warning) {
    if (alerts) motor::play("zone_warning", motor::SAFETY, true);
  } else if (z == aiss::Zone::Awareness) {
    motor::stop(motor::SAFETY);
    if (alerts) motor::play("zone_awareness", motor::SAFETY, false);   // single cue, no nagging
  } else {
    motor::stop(motor::SAFETY);
    if (z == aiss::Zone::Unknown && lastZone != aiss::Zone::Unknown && S.mode == ecu::Mode::Normal) {
      ecu::pushSafety(2, 0, 1.0f);   // sensor fault: reported, never treated as "clear"
      ecu::setError(ecu::E_US_STALE, true);
    }
  }
  if (z != aiss::Zone::Unknown) ecu::setError(ecu::E_US_STALE, false);
  lastZone = z;
}

void setup() {
  health::init();
  Serial.begin(115200);
  button::begin();                 // GPIO3 (U0RXD) reclaimed as input with pull-up after Serial init
  motor::begin();

  // Factory reset: hold the button WHILE powering on (never reachable by a long press during use,
  // so it cannot collide with the 3 s SOS hold).
  uint32_t t0 = millis();
  bool heldAtBoot = digitalRead(PIN_BUTTON) == LOW;
  if (heldAtBoot) {
    Serial.println("[boot] button held: keep holding for factory reset");
    motor::pulse(120);   // "I feel the button": the user knows the hold is being counted
  }
  while (digitalRead(PIN_BUTTON) == LOW && millis() - t0 < BOOT_RESET_HOLD_MS + 50) delay(10);
  bool bootReset = millis() - t0 >= BOOT_RESET_HOLD_MS;
  if (bootReset) {
    Serial.println("[boot] factory reset");
    motor::pulse(600);   // long buzz: reset done, release the button
    uint32_t r0 = millis();
    while (digitalRead(PIN_BUTTON) == LOW && millis() - r0 < 15000) delay(10);
  }
  // A hold that began at power-on must never turn into a click or the 3 s SOS hold.
  if (heldAtBoot) button::suppressUntilRelease();

  WiFi.mode(WIFI_STA);
  identity::load();
  if (bootReset) { identity::factoryReset(); motor::play("sos", motor::FEEDBACK); }
  config::load();
  applyConfig();
  ultrasonic::begin();
  imu::begin();
  battery::begin();
  if (health::safeMode()) S.mode = ecu::Mode::SafeMode;   // camera stays off, safety + telemetry run
  else camera::begin();
  S.camOk = camera::ok();

  net::startSetupAp();
  Serial.printf("[%s] Dashcam AP started.\n", identity::deviceId());
  api::start();
  Serial.printf("[boot] %s fw %s reset=%s boots=%lu safe=%d\n", identity::deviceId(), FW_VERSION, health::resetReason(), (unsigned long)health::bootCount(), health::safeMode());

#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t wdt = {.timeout_ms = 8000, .idle_core_mask = 0, .trigger_panic = true};
  esp_task_wdt_reconfigure(&wdt);
#else
  esp_task_wdt_init(8, true);
#endif
  esp_task_wdt_add(NULL);
  lastActivity = millis();
}

void loop() {
  static uint32_t tImu = 0, tIna = 0, tHealth = 0;
  const uint32_t now = millis();

  // ── P0 SAFETY ─────────────────────────────────────────────
  ultrasonic::Sample us = ultrasonic::tick();
  if (us.fresh) {
    S.usStatus = us.status;
    S.usCm = us.kind == 0 ? us.cm : NAN;
    S.echoUs = us.echoUs;
    S.usSampleAt = now;
  }
  if (S.mode == ecu::Mode::Normal || S.mode == ecu::Mode::SafeMode) {
    aiss::Zone z = us.fresh ? obstacle.update(us.kind, us.cm, now) : obstacle.update(2, NAN, now);  // no fresh sample → stale check only
    S.zone = z;
    safetyZone(z);
  } else S.zone = aiss::Zone::Unknown;

  if (now - tImu >= IMU_PERIOD_MS) {
    tImu = now;
    imu::Reading r = imu::read();
    S.imuOk = r.ok;
    if (r.ok) {
      S.ax = r.ax; S.ay = r.ay; S.az = r.az; S.gx = r.gx; S.gy = r.gy; S.gz = r.gz; S.pitch = r.pitch; S.roll = r.roll;
      if (fabsf(sqrtf(r.ax * r.ax + r.ay * r.ay + r.az * r.az) - 1.0f) > 0.15f) lastActivity = now;
      aiss::FallResult f = fall.update(r.ax, r.ay, r.az, now);
      if (f.detected) {
        ecu::pushSafety(0, f.peakG, f.confidence);   // the app runs the SOS countdown (if the user enabled fall SOS)
        motor::play("fall", motor::FEEDBACK);
      }
    }
  }
  motor::tick();
  S.motorRunning = motor::running();

  // ── P1 USER INPUT ─────────────────────────────────────────
  int edge = button::tick();
  if (edge == 1) {
    ecu::pushButton(0, now);
    lastActivity = now;
    if (S.mode == ecu::Mode::Sleep) setMode(ecu::Mode::Normal);   // any press wakes
  } else if (edge == 2) {
    ecu::pushButton(1, now);
  }
  if (button::down()) {
    uint32_t held = button::heldMs();
    // Immediate local feedback that the SOS hold registered (the phone decides and runs the countdown).
    if (identity::provisioned() && held >= BTN_SOS_FEEDBACK_MS && lastSosFeedbackPress != now - held) {
      lastSosFeedbackPress = now - held;
      motor::play("sos", motor::FEEDBACK);
    }
    if (!identity::provisioned() && !net::inSetup() && held >= BTN_SETUP_HOLD_MS) {
      ecu::pushButton(2, now);
      motor::play("confirm", motor::FEEDBACK);
      net::startSetupAp();
      S.mode = ecu::Mode::Setup;
    }
  }

  int m = api::takeModeRequest();
  if (m == 0) setMode(ecu::Mode::Normal);
  else if (m == 1) setMode(ecu::Mode::Sleep);
  uint16_t sleepMin = config::active().autoSleepMin;
  if (sleepMin && S.mode == ecu::Mode::Normal && now - lastActivity > (uint32_t)sleepMin * 60000UL) setMode(ecu::Mode::Sleep);
  if (config::active().configVersion != cfgApplied) applyConfig();   // new config from the API task

  // ── P2 HEALTH / NETWORK ───────────────────────────────────
  if (now - tIna >= INA_PERIOD_MS) {
    tIna = now;
    battery::Reading b = battery::read();
    S.batOk = b.ok;
    S.busV = b.busV; S.shuntMv = b.shuntMv; S.currentMa = b.currentMa; S.powerMw = b.powerMw; S.charging = b.charging;
  }
  S.i2cOk = S.imuOk || S.batOk;
  ecu::setError(ecu::E_I2C, !S.i2cOk);
  if (now - tHealth >= HEALTH_PERIOD_MS) { tHealth = now; health::tick(); }
  net::tick();
  // Dashcam mode: never switch to station.
  // if (api::takeProvisioned()) leaveApAt = now + 1500;
  // if (leaveApAt && (int32_t)(now - leaveApAt) >= 0) { leaveApAt = 0; S.mode = ecu::Mode::Normal; net::startStation(); motor::play("confirm", motor::FEEDBACK); }
  if (api::takeFactoryResetRequest()) { identity::factoryReset(); rebootAt = now + 300; }
  if (api::takeRebootRequest()) rebootAt = now + 300;
  if (rebootAt && (int32_t)(now - rebootAt) >= 0) ESP.restart();

  S.camOk = camera::ok();
  ecu::setSensors(S);               // P4 telemetry reads this snapshot from the HTTP task
  esp_task_wdt_reset();
  delay(1);                         // yield ~1 ms: loop ≈ 500–900 Hz, Wi-Fi/HTTP never starved
}
