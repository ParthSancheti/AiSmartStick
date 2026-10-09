#include "Identity.h"
#include "BoardConfig.h"
#include <WiFi.h>
#include <Preferences.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>

namespace identity {
static Preferences nvs;
static char id[20];
static char code[9];
static uint8_t key[32];
static bool prov = false;
static char nonces[32][25];
static uint8_t nonceIdx = 0;
static uint64_t maxTs = 0;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

static void hexOf(const uint8_t *b, size_t n, char *out) {
  static const char *h = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) { out[i * 2] = h[b[i] >> 4]; out[i * 2 + 1] = h[b[i] & 15]; }
  out[n * 2] = 0;
}

void load() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(id, sizeof id, "AISS-%02X%02X%02X", mac[3], mac[4], mac[5]);
  nvs.begin("aiss", false);
  String c = nvs.getString("setup", "");
  if (c.length() != 8) {
    // Hardcoded for development without a physical label
    char g[9] = "12345678";
    nvs.putString("setup", g);
    c = g;
  }
  strncpy(code, c.c_str(), sizeof code);
  prov = nvs.getBool("prov", false) && nvs.getBytes("key", key, 32) == 32;
}
const char *deviceId() { return id; }
const char *setupCode() { return code; }
bool provisioned() { return prov; }
String ssid() { return nvs.getString("ssid", ""); }
String pass() { return nvs.getString("pass", ""); }

bool storeProvisioning(const char *s, const char *p, const uint8_t k[32], const char *owner) {
  nvs.putString("ssid", s);
  nvs.putString("pass", p);
  nvs.putBytes("key", k, 32);
  nvs.putString("owner", owner);
  nvs.putBool("prov", true);
  memcpy(key, k, 32);
  prov = true;
  maxTs = 0;
  return true;
}
void factoryReset() {
  nvs.remove("prov"); nvs.remove("key"); nvs.remove("ssid"); nvs.remove("pass"); nvs.remove("owner");
  Preferences c; c.begin("aiss-cfg", false); c.clear(); c.end();
  memset(key, 0, sizeof key);
  prov = false;
}

void hmacHex(const char *msg, size_t len, char out[65]) {
  uint8_t mac[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, 32, (const uint8_t *)msg, len, mac);
  hexOf(mac, 32, out);
}
void sha256Hex(const uint8_t *data, size_t len, char out[65]) {
  uint8_t d[32];
  mbedtls_sha256(data, len, d, 0);
  hexOf(d, 32, out);
}
bool ctEqual(const char *a, const char *b) {
  size_t la = strlen(a), lb = strlen(b);
  if (la != lb) return false;
  uint8_t r = 0;
  for (size_t i = 0; i < la; i++) r |= a[i] ^ b[i];
  return r == 0;
}

static bool hdr(httpd_req_t *r, const char *n, char *out, size_t sz) { return httpd_req_get_hdr_value_str(r, n, out, sz) == ESP_OK; }

bool authorized(httpd_req_t *r, const char *method, const char *body, size_t bodyLen) {
  // v1 simple link: joining the stick's Wi-Fi is enough. The signed path below stays compiled so
  // REQUIRE_AUTH 1 still builds and works.
  if (REQUIRE_AUTH == 0) return true;
  if (!prov) return false;
  char dev[24], ts[20], nonce[25], sig[65];
  if (!hdr(r, "x-aiss-device", dev, sizeof dev) || !hdr(r, "x-aiss-ts", ts, sizeof ts) || !hdr(r, "x-aiss-nonce", nonce, sizeof nonce) || !hdr(r, "x-aiss-sig", sig, sizeof sig)) return false;
  if (strcmp(dev, id) || strlen(nonce) < 16) return false;
  uint64_t t = strtoull(ts, nullptr, 10);
  char bodySha[65] = "";
  if (body) {
    sha256Hex((const uint8_t *)body, bodyLen, bodySha);
  } else if (!hdr(r, "x-aiss-content-sha256", bodySha, sizeof bodySha)) {
    sha256Hex((const uint8_t *)"", 0, bodySha);
  }
  static char canon[600];
  int len = snprintf(canon, sizeof canon, "%s\n%s\n%s\n%s\n%s", method, r->uri, ts, nonce, bodySha);
  if (len <= 0 || len >= (int)sizeof canon) return false;
  char expect[65];
  hmacHex(canon, len, expect);
  if (!ctEqual(expect, sig)) return false;
  bool ok = true;
  portENTER_CRITICAL(&mux);
  if (maxTs && t + 30000 < maxTs) ok = false;                        // too old vs the newest accepted
  for (auto &n : nonces) if (ok && !strcmp(n, nonce)) ok = false;    // replay
  if (ok) {
    strncpy(nonces[nonceIdx++ % 32], nonce, 24);
    if (t > maxTs) maxTs = t;
  }
  portEXIT_CRITICAL(&mux);
  return ok;
}
}  // namespace identity
