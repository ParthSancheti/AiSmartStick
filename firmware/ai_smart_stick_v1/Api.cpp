#include "Api.h"
#include <esp_http_server.h>
#include <img_converters.h>
#include <mbedtls/base64.h>
#include <WiFi.h>
#include "ArduinoJson.h"
#include "BoardConfig.h"
#include "Identity.h"
#include "DeviceConfig.h"
#include "Drivers.h"
#include "Ecu.h"
#include "Health.h"
#include "Net.h"
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <atomic>

namespace api {
static httpd_handle_t server = nullptr;
static std::atomic<uint32_t> cameraWorkQueued{0};
static volatile int modeReq = -1;
static volatile bool rebootReq = false, resetReq = false, provDone = false;
static aiss::IdRing<24> seenCommands;
static portMUX_TYPE cmdMux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t telemetrySeq = 0, frameSeq = 0;
// Serial diagnostics (no effect on the safety loop: printed from the HTTP task / a low-priority task).
static volatile uint32_t httpCount = 0, telemetryCount = 0, lastTelemetryBytes = 0, lastTelemetryLogAt = 0, telemetrySinceLog = 0;
static volatile int lastTelemetryStatus = 0;

// "[HTTP] GET /api/v1/telemetry 200 1234B": every request, telemetry at most once per 2 s (with a count).
static void logHttp(httpd_req_t *r, int status, size_t bytes) {
  httpCount++;
  const char *m = r->method == HTTP_POST ? "POST" : r->method == HTTP_OPTIONS ? "OPTIONS" : "GET";
  if (!strncmp(r->uri, "/api/v1/telemetry", 17)) {
    telemetryCount++;
    lastTelemetryBytes = bytes;
    lastTelemetryStatus = status;
    telemetrySinceLog++;
    uint32_t now = millis();
    if (now - lastTelemetryLogAt < 2000) return;
    Serial.printf("[HTTP] %s %s %d %uB (%lu requests in the last %lu ms)\n", m, r->uri, status, (unsigned)bytes, (unsigned long)telemetrySinceLog, (unsigned long)(lastTelemetryLogAt ? now - lastTelemetryLogAt : 0));
    lastTelemetryLogAt = now;
    telemetrySinceLog = 0;
    return;
  }
  Serial.printf("[HTTP] %s %s %d %uB\n", m, r->uri, status, (unsigned)bytes);
}

static void cameraPowerWork(void *) {
  camera::applyPendingPower();
  cameraWorkQueued.store(0);
}
void serviceCameraPower() {
  if (!server || !camera::powerChangeReady()) return;
  uint32_t free = 0;
  if (!cameraWorkQueued.compare_exchange_strong(free, 1)) return;
  if (httpd_queue_work(server, cameraPowerWork, nullptr) != ESP_OK) cameraWorkQueued.store(0);
}

int takeModeRequest() { int m = modeReq; modeReq = -1; return m; }
bool takeRebootRequest() { bool r = rebootReq; rebootReq = false; return r; }
bool takeFactoryResetRequest() { bool r = resetReq; resetReq = false; return r; }
bool takeProvisioned() { bool r = provDone; provDone = false; return r; }

static esp_err_t send(httpd_req_t *r, int status, JsonDocument &d) {
  // Busy telemetry (16 button events, 8 safety events, errors) reaches ~2.4 KB: 2 KB truncated it
  // into invalid JSON. One buffer is safe: every handler runs in the single httpd task.
  static char buf[4096];
  size_t n = measureJson(d);
  if (n >= sizeof buf) {
    JsonDocument e;
    e["error"] = "too_large";
    n = serializeJson(e, buf, sizeof buf);
    status = 503;
  } else {
    n = serializeJson(d, buf, sizeof buf);
  }
  httpd_resp_set_status(r, status == 200 ? "200 OK" : status == 401 ? "401 Unauthorized" : status == 400 ? "400 Bad Request" : status == 409 ? "409 Conflict" : status == 413 ? "413 Payload Too Large" : "503 Service Unavailable");
  httpd_resp_set_type(r, "application/json");
  httpd_resp_set_hdr(r, "Cache-Control", "no-store");
  // Lets a browser page (dev server on a laptop joined to the stick) read the API too. The Android app
  // uses native HTTP and does not need it.
  httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*");
  esp_err_t e = httpd_resp_send(r, buf, n);
  logHttp(r, status, n);
  return e;
}
static esp_err_t error(httpd_req_t *r, int status, const char *code, const char *msg = nullptr) {
  JsonDocument d;
  d["error"] = code;
  if (msg) d["message"] = msg;
  return send(r, status, d);
}
static int readBody(httpd_req_t *r, char *buf, size_t n) {
  if (r->content_len >= n) return -2;
  int got = 0;
  while (got < (int)r->content_len) {
    int k = httpd_req_recv(r, buf + got, r->content_len - got);
    if (k <= 0) return -1;
    got += k;
  }
  buf[got] = 0;
  return got;
}
static void num(JsonObject o, const char *k, float v, int dp) {
  if (isnan(v) || isinf(v)) o[k] = nullptr;
  else o[k] = serialized(String(v, dp));
}

static void fillHealth(JsonObject h, const ecu::Sensors &s) {
  h["camera"] = !s.camOk ? "error" : s.camBusy ? "busy" : "ok";
  h["i2c"] = s.i2cOk ? "ok" : "error";
  h["motor"] = s.motorRunning ? "running" : "idle";
  h["heapFree"] = ESP.getFreeHeap();
  h["heapMin"] = health::heapMin();
  h["psramFree"] = ESP.getFreePsram();
  h["resetReason"] = health::resetReason();
  h["bootCount"] = health::bootCount();
  h["mode"] = ecu::modeName(s.mode);
  h["configVersion"] = config::active().configVersion;
  h["firmware"] = FW_VERSION;
  h["wifi"] = net::stateName();
  JsonArray e = h["errors"].to<JsonArray>();
  uint16_t bits = ecu::errors();
  static const char *names[] = {"camera_init", "camera_capture", "i2c", "imu", "ina219", "ultrasonic_stale", "wifi", "heap_low", "config"};
  for (int i = 0; i < 9; i++) if (bits & (1 << i)) e.add(names[i]);
}

static void putRssi(JsonDocument &d) {
  int v = net::rssi();
  if (v == 0) d["rssi"] = nullptr;   // unknown: never a made-up value
  else d["rssi"] = v;
}

// GET /api/v1/device[?challenge=]  (identity; no secrets). "auth": false = v1 simple link, no keys needed.
static esp_err_t hDevice(httpd_req_t *r) {
  char q[96] = "", challenge[40] = "";
  httpd_req_get_url_query_str(r, q, sizeof q);
  httpd_query_key_value(q, "challenge", challenge, sizeof challenge);
  JsonDocument d;
  d["deviceId"] = identity::deviceId();
  d["model"] = DEVICE_MODEL;
  d["firmware"] = FW_VERSION;
  d["protocolVersion"] = PROTOCOL_VERSION;
  d["paired"] = identity::provisioned();
  d["auth"] = REQUIRE_AUTH != 0;
  d["uptimeMs"] = millis();
  if (REQUIRE_AUTH != 0 && identity::provisioned() && challenge[0]) {
    char msg[64], proof[65];
    int l = snprintf(msg, sizeof msg, "%s%s", challenge, identity::deviceId());
    identity::hmacHex(msg, l, proof);
    d["proof"] = proof;
  }
  return send(r, 200, d);
}

// GET /api/v1/telemetry
static esp_err_t hTelemetry(httpd_req_t *r) {
  if (!identity::authorized(r, "GET", nullptr, 0)) return error(r, 401, "unauthorized");
  ecu::Sensors s = ecu::snapshot();
  uint32_t now = millis();
  JsonDocument d;
  d["v"] = 1;
  d["deviceId"] = identity::deviceId();
  d["seq"] = ++telemetrySeq;
  d["uptimeMs"] = now;
  JsonObject b = d["battery"].to<JsonObject>();
  num(b, "busV", s.busV, 3); num(b, "shuntMv", s.shuntMv, 2); num(b, "currentMa", s.currentMa, 1); num(b, "powerMw", s.powerMw, 0);
  if (s.charging < 0) b["charging"] = nullptr; else b["charging"] = s.charging == 1;
  b["chargeSource"] = PIN_CHARGE_STAT >= 0 ? "pin" : "current";
  b["ok"] = s.batOk;
  JsonObject i = d["imu"].to<JsonObject>();
  num(i, "ax", s.ax, 3); num(i, "ay", s.ay, 3); num(i, "az", s.az, 3); num(i, "gx", s.gx, 1); num(i, "gy", s.gy, 1); num(i, "gz", s.gz, 1);
  num(i, "pitch", s.pitch, 1); num(i, "roll", s.roll, 1);
  i["ok"] = s.imuOk;
  JsonObject u = d["ultrasonic"].to<JsonObject>();
  num(u, "distanceCm", s.usCm, 1);
  u["echoUs"] = s.echoUs;
  u["status"] = s.usStatus;
  u["sampleAgeMs"] = s.usSampleAt ? now - s.usSampleAt : 0;
  u["zone"] = aiss::zoneName(s.zone);
  JsonArray btn = d["button"].to<JsonArray>();
  ecu::EventRec ev[16];
  int n = ecu::recentButtons(ev, 16, 5000);
  for (int k = 0; k < n; k++) {
    JsonObject e = btn.add<JsonObject>();
    e["id"] = ev[k].id;
    e["kind"] = ev[k].kind == 2 ? "gesture" : ev[k].kind == 0 ? "press" : "release";
    if (ev[k].kind == 2) e["gesture"] = "setup";
    e["atMs"] = ev[k].atMs;
  }
  JsonArray saf = d["safety"].to<JsonArray>();
  ecu::SafetyRec sr[8];
  n = ecu::recentSafety(sr, 8, 10000);
  static const char *types[] = {"fall", "obstacle", "sensor_fault"};
  for (int k = 0; k < n; k++) {
    JsonObject e = saf.add<JsonObject>();
    e["id"] = sr[k].id;
    e["type"] = types[sr[k].type];
    e["atMs"] = sr[k].atMs;
    num(e, "value", sr[k].value, 2);
    num(e, "confidence", sr[k].confidence, 2);
  }
  putRssi(d);
  fillHealth(d["health"].to<JsonObject>(), s);
  return send(r, 200, d);
}

// GET /api/v1/status  (health only, cheaper than telemetry)
static esp_err_t hStatus(httpd_req_t *r) {
  if (!identity::authorized(r, "GET", nullptr, 0)) return error(r, 401, "unauthorized");
  JsonDocument d;
  d["deviceId"] = identity::deviceId();
  d["protocolVersion"] = PROTOCOL_VERSION;
  d["uptimeMs"] = millis();
  putRssi(d);
  fillHealth(d["health"].to<JsonObject>(), ecu::snapshot());
  return send(r, 200, d);
}

// GET /api/v1/config
static esp_err_t hConfig(httpd_req_t *r) {
  if (!identity::authorized(r, "GET", nullptr, 0)) return error(r, 401, "unauthorized");
  JsonDocument d;
  config::toJson(d.to<JsonObject>());
  return send(r, 200, d);
}

// GET /api/v1/capture  (P3; runs in the HTTP task, never in the safety loop)
// The camera is shared by the API task (capture, selfTest) and the port-81 stream task: one frame
// at a time, so camera::capture()'s recovery (deinit after 3 failures) never runs while the other
// task still holds a frame buffer.
static esp_err_t hCapture(httpd_req_t *r) {
  if (!identity::authorized(r, "GET", nullptr, 0)) return error(r, 401, "unauthorized");
  if (health::safeMode() || !camera::ok()) return error(r, 503, "camera_error", health::safeMode() ? "safe mode" : "camera not available");
  if (!camera::tryLock()) return error(r, 409, "busy");
  camera_fb_t *fb = camera::capture();
  if (!fb) { camera::unlock(); return error(r, 503, "camera_error", "capture failed"); }
  uint8_t *jpg = fb->buf; size_t jpgLen = fb->len; bool converted = false;
  if (fb->format != PIXFORMAT_JPEG) {
    converted = camera::toJpeg(fb, &jpg, &jpgLen);
    if (!converted) { camera::release(fb); camera::unlock(); return error(r, 503, "camera_error", "jpeg conversion failed"); }
  }
  char w[8], h[8], s[12], ts[16];
  snprintf(w, 8, "%u", fb->width); snprintf(h, 8, "%u", fb->height); snprintf(s, 12, "%lu", (unsigned long)++frameSeq); snprintf(ts, 16, "%lu", millis());
  httpd_resp_set_type(r, "image/jpeg");
  httpd_resp_set_hdr(r, "Cache-Control", "no-store");
  // The app's WebView fallback path (fetch from https://localhost) needs CORS for the camera too.
  httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(r, "Access-Control-Expose-Headers", "x-aiss-width, x-aiss-height, x-aiss-seq, x-aiss-ts");
  httpd_resp_set_hdr(r, "x-aiss-width", w);
  httpd_resp_set_hdr(r, "x-aiss-height", h);
  httpd_resp_set_hdr(r, "x-aiss-seq", s);
  httpd_resp_set_hdr(r, "x-aiss-ts", ts);
  esp_err_t e = httpd_resp_send(r, (const char *)jpg, jpgLen);
  logHttp(r, 200, jpgLen);
  if (converted) free(jpg);
  camera::release(fb);   // RELEASE: the buffer returns to the driver immediately
  camera::unlock();
  return e;
}

// POST /api/v1/command  — envelope {commandId, type, payload, issuedAt, expiresAt} → CommandAck
static esp_err_t hCommand(httpd_req_t *r) {
  static char body[1024];
  int len = readBody(r, body, sizeof body);
  if (len == -2) return error(r, 413, "bad_request", "payload too large");
  if (len < 0) return error(r, 400, "bad_request");
  if (!identity::authorized(r, "POST", body, len)) return error(r, 401, "unauthorized");
  JsonDocument in;
  if (deserializeJson(in, body, len)) return error(r, 400, "bad_request", "malformed JSON");
  const char *cid = in["commandId"] | "";
  const char *type = in["type"] | "";
  if (!cid[0] || strlen(cid) > 39 || !type[0]) return error(r, 400, "bad_request", "commandId and type required");
  JsonDocument ack;
  ack["commandId"] = cid;
  bool dup;
  portENTER_CRITICAL(&cmdMux);
  dup = seenCommands.seen(cid);
  if (!dup) seenCommands.add(cid);
  portEXIT_CRITICAL(&cmdMux);
  if (dup) { ack["status"] = "duplicate"; return send(r, 200, ack); }   // idempotent: never execute twice
  char ts[20] = "";
  httpd_req_get_hdr_value_str(r, "x-aiss-ts", ts, sizeof ts);
  uint64_t expires = in["expiresAt"] | (uint64_t)0;
  if (expires && expires < strtoull(ts, nullptr, 10)) { ack["status"] = "expired"; return send(r, 200, ack); }
  JsonObjectConst p = in["payload"];

  if (!strcmp(type, "haptic")) {
    const char *pat = p["pattern"] | "";
    int intensity = p["intensity"] | 0;
    if (!motor::knownPattern(pat) || !strncmp(pat, "zone_", 5) || intensity < 0 || intensity > 100) { ack["status"] = "rejected"; ack["error"] = "unknown pattern"; }
    else if (!motor::play(pat, motor::COMMAND, false, intensity)) { ack["status"] = "failed"; ack["error"] = "safety alert in progress"; }
    else ack["status"] = "completed";
  } else if (!strcmp(type, "locate")) {
    ack["status"] = motor::play("locate", motor::COMMAND) ? "completed" : "failed";
  } else if (!strcmp(type, "nudge")) {
    ack["status"] = motor::play("nudge", motor::COMMAND) ? "completed" : "failed";
  } else if (!strcmp(type, "setConfig")) {
    String err;
    if (config::apply(p["config"], err)) { ack["status"] = "completed"; ack["result"]["configVersion"] = config::active().configVersion; }
    else { ack["status"] = "rejected"; ack["error"] = err; }
  } else if (!strcmp(type, "getConfig")) {
    ack["status"] = "completed";
    config::toJson(ack["result"].to<JsonObject>());
  } else if (!strcmp(type, "setMode")) {
    const char *m = p["mode"] | "";
    if (!strcmp(m, "normal")) { modeReq = 0; ack["status"] = "completed"; }
    else if (!strcmp(m, "sleep")) { modeReq = 1; ack["status"] = "completed"; }
    else { ack["status"] = "rejected"; ack["error"] = "mode must be normal or sleep"; }
  } else if (!strcmp(type, "selfTest")) {
    // Hardware diagnostics (FIRMWARE_SETUP.md §Hardware test). Safe: short motor pulse, one capture.
    JsonObject res = ack["result"].to<JsonObject>();
    ecu::Sensors s = ecu::snapshot();
    res["imu"] = s.imuOk ? "ok" : "error";
    res["battery"]["ok"] = s.batOk;
    num(res["battery"].as<JsonObject>(), "busV", s.busV, 3);
    res["ultrasonic"]["status"] = s.usStatus;
    num(res["ultrasonic"].as<JsonObject>(), "distanceCm", s.usCm, 1);
    res["button"] = "press the button once within 10 s and check telemetry";
    res["motor"] = motor::play("confirm", motor::COMMAND) ? "pulsed" : "busy";
    bool camLocked = !health::safeMode() && camera::tryLock();
    camera_fb_t *fb = camLocked ? camera::capture() : nullptr;
    res["camera"]["ok"] = fb != nullptr;
    if (fb) { res["camera"]["bytes"] = fb->len; res["camera"]["width"] = fb->width; camera::release(fb); }
    res["camera"]["sensorPid"] = camera::sensorPid();
    res["camera"]["format"] = camera::jpeg() ? "jpeg" : "rgb565";
    if (camLocked) camera::unlock();
    res["heapFree"] = ESP.getFreeHeap();
    res["psram"] = psramFound();
    res["resetReason"] = health::resetReason();
    ack["status"] = "completed";
  } else if (!strcmp(type, "calibrateImu")) {
    ack["status"] = "completed";
    ack["result"]["note"] = "zero reference is applied in the app";
  } else if (!strcmp(type, "reboot")) {
    rebootReq = true; ack["status"] = "completed";
  } else if (!strcmp(type, "factoryReset")) {
    resetReq = true; ack["status"] = "completed";
  } else {
    ack["status"] = "rejected";
    ack["error"] = "unknown command";
  }
  return send(r, 200, ack);
}

// POST /api/v1/provision  (setup AP only)
static esp_err_t hProvision(httpd_req_t *r) {
  if (!net::inSetup()) return error(r, 409, "provision_failed", "not in setup mode");
  static char body[640];
  int len = readBody(r, body, sizeof body);
  if (len < 0) return error(r, 400, "bad_request");
  JsonDocument in;
  if (deserializeJson(in, body, len)) return error(r, 400, "bad_request", "malformed JSON");
  const char *ssid = in["ssid"] | "";
  const char *pass = in["password"] | "";
  const char *keyB64 = in["deviceKey"] | "";
  const char *owner = in["ownerHash"] | "";
  if ((in["v"] | 0) != 1 || !ssid[0] || strlen(ssid) > 32 || strlen(pass) < 8 || strlen(pass) > 63) return error(r, 400, "bad_request", "invalid Wi-Fi credentials");
  uint8_t key[48];
  size_t olen = 0;
  if (mbedtls_base64_decode(key, sizeof key, &olen, (const uint8_t *)keyB64, strlen(keyB64)) != 0 || olen != 32) return error(r, 400, "bad_request", "invalid key");
  identity::storeProvisioning(ssid, pass, key, owner);
  memset(key, 0, sizeof key);
  JsonDocument d;
  d["ok"] = true;
  d["deviceId"] = identity::deviceId();
  d["model"] = DEVICE_MODEL;
  d["firmware"] = FW_VERSION;
  d["protocolVersion"] = PROTOCOL_VERSION;
  provDone = true;   // control loop leaves AP mode after this response is delivered
  return send(r, 200, d);
}

// GET /api/v1/ota/status
static esp_err_t hOtaStatus(httpd_req_t *r) {
  if (!identity::authorized(r, "GET", nullptr, 0)) return error(r, 401, "unauthorized");
  JsonDocument d;
  d["status"] = "IDLE";
  const esp_partition_t *p = esp_ota_get_running_partition();
  d["running_partition"] = p ? p->label : "unknown";
  return send(r, 200, d);
}

// POST /api/v1/ota
static esp_err_t hOta(httpd_req_t *r) {
  if (!identity::authorized(r, "POST", nullptr, 0)) return error(r, 401, "unauthorized");
  ecu::Sensors s = ecu::snapshot();
  if (!s.batOk || (s.charging != 1 && s.powerMw < 30) || motor::running()) return error(r, 409, "ota_failed", "battery low or system busy");

  const esp_partition_t *update_partition = esp_ota_get_next_update_partition(NULL);
  if (!update_partition) return error(r, 500, "ota_failed", "no ota partition");

  esp_ota_handle_t update_handle = 0;
  esp_err_t err = esp_ota_begin(update_partition, OTA_WITH_SEQUENTIAL_WRITES, &update_handle);
  if (err != ESP_OK) return error(r, 500, "ota_failed", "esp_ota_begin failed");

  char buf[1024];
  int received = 0;
  while (received < r->content_len) {
    int ret = httpd_req_recv(r, buf, std::min((size_t)sizeof(buf), (size_t)(r->content_len - received)));
    if (ret <= 0) {
      if (ret == HTTPD_SOCK_ERR_TIMEOUT) continue;
      esp_ota_abort(update_handle);
      return error(r, 500, "ota_failed", "connection closed");
    }
    err = esp_ota_write(update_handle, buf, ret);
    if (err != ESP_OK) {
      esp_ota_abort(update_handle);
      return error(r, 500, "ota_failed", "esp_ota_write failed");
    }
    received += ret;
  }

  err = esp_ota_end(update_handle);
  if (err != ESP_OK) return error(r, 500, "ota_failed", "esp_ota_end failed");

  err = esp_ota_set_boot_partition(update_partition);
  if (err != ESP_OK) return error(r, 500, "ota_failed", "esp_ota_set_boot_partition failed");

  JsonDocument d;
  d["ok"] = true;
  d["status"] = "SUCCESS";
  send(r, 200, d);
  rebootReq = true;
  return ESP_OK;
}

// GET /  — a quick "is the stick alive?" check from any browser joined to SmartStick_AI.
static esp_err_t hRoot(httpd_req_t *r) {
  static char page[320];
  int n = snprintf(page, sizeof page,
                   "AI SmartStick %s\nfirmware %s, protocol v%d, auth %s, uptime %lu s\n"
                   "Telemetry: http://192.168.4.1/api/v1/telemetry\n",
                   identity::deviceId(), FW_VERSION, PROTOCOL_VERSION, REQUIRE_AUTH ? "on" : "off", (unsigned long)(millis() / 1000));
  if (n < 0) n = 0;
  if (n >= (int)sizeof page) n = sizeof page - 1;
  httpd_resp_set_type(r, "text/plain");
  httpd_resp_set_hdr(r, "Cache-Control", "no-store");
  httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*");
  esp_err_t e = httpd_resp_send(r, page, n);
  logHttp(r, 200, n);
  return e;
}

// OPTIONS (CORS preflight) for the POST routes: a WebView/browser fetch with a JSON body asks first.
static esp_err_t hPreflight(httpd_req_t *r) {
  httpd_resp_set_status(r, "204 No Content");
  httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(r, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  httpd_resp_set_hdr(r, "Access-Control-Allow-Headers", "content-type, x-aiss-ts, x-aiss-content-sha256");
  httpd_resp_set_hdr(r, "Access-Control-Max-Age", "600");
  esp_err_t e = httpd_resp_send(r, nullptr, 0);
  logHttp(r, 204, 0);
  return e;
}

// ── MJPEG live stream on port 81: GET http://192.168.4.1:81/stream ──────────
// Same protocol as the old working sketch (sketch_sep19b): multipart/x-mixed-replace, one JPEG per part.
// Separate server so a long-running stream never blocks /api/v1/* (telemetry keeps flowing).
static httpd_handle_t streamServer = nullptr;
#define STREAM_BOUNDARY "123456789000000000000987654321"
static esp_err_t hStream(httpd_req_t *r) {
  // Own constant answer: send()'s static buffer belongs to the API server task, never share it.
  if (health::safeMode() || !camera::ok()) {
    static const char kErr[] = "{\"error\":\"camera_error\",\"message\":\"camera not available\"}";
    httpd_resp_set_status(r, "503 Service Unavailable");
    httpd_resp_set_type(r, "application/json");
    return httpd_resp_send(r, kErr, sizeof kErr - 1);
  }
  Serial.println("[stream] viewer connected");
  httpd_resp_set_type(r, "multipart/x-mixed-replace;boundary=" STREAM_BOUNDARY);
  httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*");
  char part[96];
  int misses = 0;   // consecutive loops without a frame (camera busy in the API task, or dead)
  while (true) {
    // Share the camera with /api/v1/capture: never capture while the API task holds a frame.
    camera_fb_t *fb = nullptr;
    if (camera::tryLock()) {
      fb = camera::ok() ? camera::capture() : nullptr;
      if (!fb) camera::unlock();
    }
    if (!fb) {
      // A dead camera (or one that stays busy) ends the stream after ~3 s, so a viewer that left is
      // never waited on forever and the stream task is free for the next one.
      if (++misses >= 60) { Serial.println("[stream] no frames, closing the stream"); break; }
      delay(50);
      continue;
    }
    misses = 0;
    uint8_t *jpg = fb->buf; size_t len = fb->len; bool conv = false;
    if (fb->format != PIXFORMAT_JPEG) { conv = camera::toJpeg(fb, &jpg, &len); if (!conv) { camera::release(fb); camera::unlock(); continue; } }
    // The JPEG copy is ours: hand the raw buffer back so the sensor fills the next frame while we send.
    if (conv) { camera::release(fb); fb = nullptr; }
    int hl = snprintf(part, sizeof part, "\r\n--" STREAM_BOUNDARY "\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", (unsigned)len);
    esp_err_t e = httpd_resp_send_chunk(r, part, hl);
    if (e == ESP_OK) e = httpd_resp_send_chunk(r, (const char *)jpg, len);
    if (conv) free(jpg);
    camera::release(fb);
    camera::unlock();
    if (e != ESP_OK) break;   // phone closed the stream
    delay(30);
  }
  httpd_resp_send_chunk(r, nullptr, 0);
  return ESP_OK;
}
static void startStream() {
  if (streamServer) return;
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port = 81;
  cfg.ctrl_port = 32769;
  // Socket budget (lwIP has CONFIG_LWIP_MAX_SOCKETS, 10 by default; each server also holds a listen
  // and a control socket): API 4+2 + stream 1+2 = 9. One live viewer at a time: hStream loops in this
  // server's only task, so a second viewer waits until the first one's send fails (a gone viewer
  // is detected within send_wait_timeout) or the stream ends.
  cfg.max_open_sockets = 1;
  cfg.lru_purge_enable = true;
  cfg.send_wait_timeout = 2;
  cfg.core_id = 0;
  cfg.task_priority = tskIDLE_PRIORITY + 2;   // below the API server
  if (httpd_start(&streamServer, &cfg) != ESP_OK) { Serial.println("[stream] port 81 failed"); return; }
  httpd_uri_t u = {"/stream", HTTP_GET, hStream, nullptr};
  httpd_register_uri_handler(streamServer, &u);
  Serial.println("[stream] MJPEG at http://192.168.4.1:81/stream");
}

// One compact line every 2 s, so the serial monitor proves the stick side on its own:
// [TELEMETRY] seq=.. us=..cm(status) zone=.. bat=..V ..mA imu=ok/err pitch=.. roll=.. heap=.. clients=..
// Low-priority task on core 0: the safety loop (core 1) never waits for the UART.
static void diagTask(void *) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(2000));
    ecu::Sensors s = ecu::snapshot();
    Serial.printf("[TELEMETRY] seq=%lu us=%.1fcm(%s) zone=%s bat=%.2fV %.0fmA imu=%s pitch=%.1f roll=%.1f heap=%u clients=%d http=%lu last=%d/%luB\n",
                  (unsigned long)telemetrySeq, s.usCm, s.usStatus, aiss::zoneName(s.zone), s.busV, s.currentMa, s.imuOk ? "ok" : "err", s.pitch, s.roll,
                  (unsigned)ESP.getFreeHeap(), (int)WiFi.softAPgetStationNum(), (unsigned long)httpCount, lastTelemetryStatus, (unsigned long)lastTelemetryBytes);
  }
}

void start() {
  if (server) return;
#if defined(CONFIG_LWIP_MAX_SOCKETS) && CONFIG_LWIP_MAX_SOCKETS < 9
#warning "CONFIG_LWIP_MAX_SOCKETS < 9: the API (4) and stream (1) servers may run out of sockets"
#endif
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  // 4 phone connections (telemetry poll + capture + command + a browser) — see the socket budget above.
  cfg.max_open_sockets = 4;
  cfg.lru_purge_enable = true;
  cfg.stack_size = 10240;
  cfg.max_uri_handlers = 12;
  cfg.recv_wait_timeout = 5;   // seconds; a phone that walks out of range must not hold a socket for long
  cfg.send_wait_timeout = 5;
  cfg.core_id = 0;          // control loop runs on core 1 (Arduino); HTTP/camera on core 0 with Wi-Fi
  cfg.task_priority = tskIDLE_PRIORITY + 3;
  if (httpd_start(&server, &cfg) != ESP_OK) {
    Serial.println("[HTTP] API server on port 80 FAILED to start");
    return;
  }
  Serial.println("[HTTP] API at http://192.168.4.1/api/v1/telemetry (port 80, 4 sockets)");
  httpd_uri_t routes[] = {
    {"/api/v1/device", HTTP_GET, hDevice, nullptr},
    {"/api/v1/status", HTTP_GET, hStatus, nullptr},
    {"/api/v1/telemetry", HTTP_GET, hTelemetry, nullptr},
    {"/api/v1/config", HTTP_GET, hConfig, nullptr},
    {"/api/v1/capture", HTTP_GET, hCapture, nullptr},
    {"/api/v1/command", HTTP_POST, hCommand, nullptr},
    {"/api/v1/provision", HTTP_POST, hProvision, nullptr},
    {"/api/v1/ota/status", HTTP_GET, hOtaStatus, nullptr},
    {"/api/v1/ota", HTTP_POST, hOta, nullptr},
    {"/", HTTP_GET, hRoot, nullptr},
    // CORS preflights (max_uri_handlers = 12: 10 routes + these 2).
    {"/api/v1/command", HTTP_OPTIONS, hPreflight, nullptr},
    {"/api/v1/ota", HTTP_OPTIONS, hPreflight, nullptr},
  };
  for (auto &u : routes) httpd_register_uri_handler(server, &u);
  startStream();
  xTaskCreatePinnedToCore(diagTask, "diag", 4096, nullptr, tskIDLE_PRIORITY + 1, nullptr, 0);
}
}  // namespace api
