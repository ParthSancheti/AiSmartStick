#include "Net.h"
#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_wifi.h>
#include "BoardConfig.h"
#include "Identity.h"
#include "Ecu.h"

namespace net {
static State st = State::Off;
static uint32_t attemptAt = 0, backoff = 2000, lastAnnounce = 0;
static WiFiUDP udp;
static bool udpUp = false;

const char *stateName() {
  switch (st) {
    case State::Connecting: return "connecting";
    case State::Connected: return "connected";
    case State::Lost: return "lost";
    case State::SetupAp: return "setup_ap";
    default: return "off";
  }
}
bool inSetup() { return st == State::SetupAp; }
// Station mode: the router's signal. Access-point mode: the signal of the (first) phone that joined.
// 0 = unknown (reported as null in telemetry, never as a made-up value).
int rssi() {
  if (st == State::Connected) return WiFi.RSSI();
  if (st == State::SetupAp) {
    wifi_sta_list_t list;
    if (esp_wifi_ap_get_sta_list(&list) == ESP_OK && list.num > 0) return list.sta[0].rssi;
  }
  return 0;
}

void startStation() {
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);            // telemetry latency beats a few mA here
  WiFi.setAutoReconnect(false);    // we own reconnect (backoff, no storm)
  String s = identity::ssid(), p = identity::pass();
  WiFi.begin(s.c_str(), p.c_str());
  st = State::Connecting;
  attemptAt = millis();
  backoff = 2000;
}

void startSetupAp() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP);
  // Fixed, well-known AP: the phone joins it directly (v1 simple link, no keys).
  bool ok = WiFi.softAP(STICK_AP_SSID, STICK_AP_PASS, STICK_AP_CHANNEL, 0, STICK_AP_MAX_STA);
  st = State::SetupAp;
  Serial.printf("[dashcam] AP %s %s at %s (password %s, channel %d)\n", STICK_AP_SSID, ok ? "up" : "FAILED", WiFi.softAPIP().toString().c_str(), STICK_AP_PASS, STICK_AP_CHANNEL);
}

void tick() {
  uint32_t now = millis();
  if (st == State::SetupAp || st == State::Off) return;
  wl_status_t w = WiFi.status();
  if (w == WL_CONNECTED) {
    if (st != State::Connected) {
      st = State::Connected;
      backoff = 2000;
      ecu::setError(ecu::E_WIFI, false);
      if (!udpUp) udpUp = udp.begin(DISCOVERY_PORT + 1);
      lastAnnounce = 0;
    }
  } else if (st == State::Connected) {
    st = State::Lost;
    attemptAt = now;
    ecu::setError(ecu::E_WIFI, true);
  }
  if ((st == State::Connecting || st == State::Lost) && now - attemptAt > backoff) {
    // Exponential backoff 2 → 4 → 8 → … 30 s: no reconnect storms, safety loop never waits.
    WiFi.disconnect();
    String s = identity::ssid(), p = identity::pass();
    WiFi.begin(s.c_str(), p.c_str());
    attemptAt = now;
    backoff = backoff * 2 > 30000 ? 30000 : backoff * 2;
  }
  if (st == State::Connected && identity::provisioned() && now - lastAnnounce >= DISCOVERY_PERIOD_MS) {
    lastAnnounce = now;
    String ip = WiFi.localIP().toString();
    char msg[96];
    unsigned long up = now;
    int l = snprintf(msg, sizeof msg, "%s%s%lu", identity::deviceId(), ip.c_str(), up);
    char sig[65];
    identity::hmacHex(msg, l, sig);
    char json[256];
    int jl = snprintf(json, sizeof json, "{\"v\":1,\"deviceId\":\"%s\",\"ip\":\"%s\",\"port\":80,\"uptimeMs\":%lu,\"sig\":\"%s\"}", identity::deviceId(), ip.c_str(), up, sig);
    udp.beginPacket(IPAddress(255, 255, 255, 255), DISCOVERY_PORT);
    udp.write((const uint8_t *)json, jl);
    udp.endPacket();
  }
}
}  // namespace net
