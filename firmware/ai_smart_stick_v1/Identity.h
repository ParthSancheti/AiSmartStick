// Device identity, key material and request authentication (DEVICE_PROTOCOL.md §Authentication).
#pragma once
#include <Arduino.h>
#include <esp_http_server.h>

namespace identity {
void load();
const char *deviceId();
const char *setupCode();
bool provisioned();
bool storeProvisioning(const char *ssid, const char *pass, const uint8_t key[32], const char *ownerHash);
void factoryReset();
String ssid();
String pass();
void hmacHex(const char *msg, size_t len, char out[65]);
void sha256Hex(const uint8_t *data, size_t len, char out[65]);
bool ctEqual(const char *a, const char *b);
/** Verifies x-aiss-* headers over METHOD\npath\nts\nnonce\nsha256(body); records nonce on success. */
bool authorized(httpd_req_t *r, const char *method, const char *body, size_t bodyLen);
}
