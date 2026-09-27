// Wi-Fi manager (STA with exponential backoff), setup AP and signed UDP discovery.
#pragma once
#include <Arduino.h>

namespace net {
enum class State : uint8_t { Off, Connecting, Connected, Lost, SetupAp };
const char *stateName();
void startStation();
void startSetupAp();
bool inSetup();
void tick();           // non-blocking reconnect + discovery announce
int rssi();
}
