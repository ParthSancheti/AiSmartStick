// HTTP API (esp_http_server, own task). Implements DEVICE_PROTOCOL.md v1 endpoints.
#pragma once
#include <Arduino.h>
namespace api {
void start();
/** Nonblocking scheduling of pending camera power work on the existing HTTP task. */
void serviceCameraPower();
/** Mode requests from commands, consumed by the control loop. */
int takeModeRequest();       // -1 none, 0 normal, 1 sleep
bool takeRebootRequest();
bool takeFactoryResetRequest();
bool takeProvisioned();      // provisioning finished → leave AP after the response
}
