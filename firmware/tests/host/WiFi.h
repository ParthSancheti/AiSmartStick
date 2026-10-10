#pragma once
constexpr int WIFI_STA = 1;
struct HostWiFi { void mode(int) {} };
inline HostWiFi WiFi;
