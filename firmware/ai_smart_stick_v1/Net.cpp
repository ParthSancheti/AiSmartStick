#include "Net.h"
#include <WiFi.h>
#include <WiFiUdp.h>
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
int rssi() { return st == State::Connected ? WiFi.RSSI() : 0; }

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
  char ssid[32];
  const char *id = identity::deviceId();
  snprintf(ssid, sizeof ssid, "AISmartStick-%s", id + strlen(id) - 4);
  WiFi.softAP(ssid, identity::setupCode());   // WPA2; password = setup code on the label
  st = State::SetupAp;
  Serial.printf("[setup] AP %s at %s (PASSWORD: %s)\n", ssid, WiFi.softAPIP().toString().c_str(), identity::setupCode());
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
