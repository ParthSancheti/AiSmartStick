// Executes actual stick_main.cpp with only external hardware/network calls replaced.
// Run from repository root:
// g++ -std=c++17 -O1 -Wall -Wextra -Ifirmware/tests/host -Ifirmware/ai_smart_stick_v1
//   firmware/tests/test_control.cpp -o /tmp/aiss_control_test && /tmp/aiss_control_test
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>
#include "../ai_smart_stick_v1/stick_main.cpp"

namespace test_hw {
bool safeBoot = false, usEnabled = true, cameraAvailable = false;
bool powerBusy = true;
int cameraInitializations = 0, cameraServiceCalls = 0;
int errors = 0;
std::string motorPattern;
motor::Priority motorPriority = motor::COMMAND;
std::vector<bool> cameraRequests;
std::vector<uint8_t> safetyEvents;
ultrasonic::Sample nextUs{false, 2, NAN, 0, "error"};
DeviceConfig configuration;
}

namespace config {
DeviceConfig &active() { return test_hw::configuration; }
void load() {}
}
namespace motor {
void begin() {}
void setIntensity(uint8_t) {}
void pulse(uint16_t) {}
bool play(const char *pattern, Priority priority, bool, uint8_t) {
  if (!test_hw::motorPattern.empty() && priority < test_hw::motorPriority) return false;
  test_hw::motorPattern = pattern;
  test_hw::motorPriority = priority;
  return true;
}
void stop(Priority priority) {
  if (priority >= test_hw::motorPriority) test_hw::motorPattern.clear();
}
void tick() {}
bool running() { return !test_hw::motorPattern.empty(); }
}
namespace ultrasonic {
void begin() {}
void setEnabled(bool on) { test_hw::usEnabled = on; }
Sample tick() { auto sample = test_hw::nextUs; test_hw::nextUs.fresh = false; return sample; }
}
namespace imu {
bool begin() { return false; }
Reading read() { return {false, NAN, NAN, NAN, NAN, NAN, NAN, NAN, NAN}; }
}
namespace battery {
bool begin() { return false; }
Reading read() { return {false, NAN, NAN, NAN, NAN, -1}; }
}
namespace button {
void begin() {}
void suppressUntilRelease() {}
int tick() { return 0; }
bool down() { return false; }
uint32_t heldMs() { return 0; }
}
namespace camera {
bool begin() { test_hw::cameraInitializations++; return test_hw::cameraAvailable; }
bool ok() { return test_hw::cameraAvailable; }
void requestPower(bool on) { test_hw::cameraRequests.push_back(on); }
}
namespace ecu {
void setSensors(const Sensors &) {}
void pushButton(uint8_t, uint32_t) {}
void pushSafety(uint8_t type, float, float) { test_hw::safetyEvents.push_back(type); }
void setError(uint16_t bit, bool on) {
  test_hw::errors = on ? test_hw::errors | bit : test_hw::errors & ~bit;
}
}
namespace identity {
void load() {}
void factoryReset() {}
bool provisioned() { return false; }
const char *deviceId() { return "host-stick"; }
}
namespace net {
void startSetupAp() {}
bool inSetup() { return false; }
void tick() {} // No phone, Firebase, Gemini, or internet exists in this host test.
}
namespace api {
void start() {}
void serviceCameraPower() {
  test_hw::cameraServiceCalls++;
  if (test_hw::powerBusy) return; // Pending camera work cannot disable local warnings.
}
int takeModeRequest() { return -1; }
bool takeFactoryResetRequest() { return false; }
bool takeRebootRequest() { return false; }
}
namespace health {
void init() {}
bool safeMode() { return test_hw::safeBoot; }
const char *resetReason() { return "host"; }
uint32_t bootCount() { return 1; }
void tick() {}
}

static int passes = 0, fails = 0;
#define CHECK(c) do { if (c) passes++; else { fails++; std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #c); } } while (0)

static void reset(ecu::Mode mode, bool safeBoot = false) {
  obstacle = aiss::ObstacleFsm();
  fall = aiss::FallDetector();
  S = ecu::Sensors();
  S.mode = mode;
  lastZone = aiss::Zone::Unknown;
  cfgApplied = 0;
  rebootAt = leaveApAt = 0;
  test_hw::nowMs += 10'000;
  test_hw::configuration = DeviceConfig();
  test_hw::safeBoot = safeBoot;
  test_hw::motorPattern.clear();
  test_hw::motorPriority = motor::COMMAND;
  test_hw::cameraAvailable = false;
  test_hw::cameraInitializations = test_hw::cameraServiceCalls = 0;
  test_hw::cameraRequests.clear();
  test_hw::safetyEvents.clear();
  test_hw::errors = 0;
}

static void feed(float cm, int samples = 5) {
  for (int i = 0; i < samples; i++) {
    test_hw::nowMs += US_PERIOD_MS;
    test_hw::nextUs = {true, 0, cm, (uint32_t)(cm * 58), "ok"};
    loop();
  }
}

static std::string source(const char *path) {
  std::ifstream input(path);
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

int main() {
  // Offline local Warning/Danger cues survive camera failure and busy camera power work.
  for (ecu::Mode mode : {ecu::Mode::Normal, ecu::Mode::SafeMode}) {
    reset(mode, mode == ecu::Mode::SafeMode);
    feed(90);
    CHECK(S.zone == aiss::Zone::Warning);
    CHECK(test_hw::motorPattern == "zone_warning");
    CHECK(test_hw::motorPriority == motor::SAFETY);
    feed(30);
    CHECK(S.zone == aiss::Zone::Danger);
    CHECK(test_hw::motorPattern == "zone_danger");
    CHECK(test_hw::cameraInitializations == 0 && test_hw::cameraServiceCalls > 0);
    CHECK(!test_hw::safetyEvents.empty() && test_hw::safetyEvents.back() == 1);
    test_hw::nowMs += 501;
    test_hw::nextUs.fresh = false;
    loop();
    CHECK(S.zone == aiss::Zone::Unknown);
    CHECK(test_hw::motorPattern.empty());
    CHECK((test_hw::errors & ecu::E_US_STALE) != 0);
    CHECK(test_hw::safetyEvents.back() == 2);
  }

  // Explicit sleep remains user-controlled; wake replays a still-confirmed danger zone.
  for (bool safeBoot : {false, true}) {
    reset(ecu::normalModeAfterWake(safeBoot), safeBoot);
    feed(30);
    setMode(ecu::Mode::Sleep);
    CHECK(!test_hw::usEnabled && test_hw::motorPattern.empty());
    CHECK(!test_hw::cameraRequests.back());
    setMode(ecu::Mode::Normal);
    CHECK(S.mode == ecu::normalModeAfterWake(safeBoot));
    CHECK(test_hw::usEnabled);
    CHECK(test_hw::cameraRequests.back() == !safeBoot);
    test_hw::nextUs.fresh = false;
    loop();
    CHECK(S.zone == aiss::Zone::Danger && test_hw::motorPattern == "zone_danger");
    CHECK(test_hw::cameraInitializations == 0); // No blocking camera initialization in safety task.
  }

  // Existing user configuration is respected and automatic sleep stays disabled by default.
  reset(ecu::Mode::SafeMode, true);
  test_hw::configuration.obstacleHaptics = false;
  feed(30);
  CHECK(S.zone == aiss::Zone::Danger && test_hw::motorPattern.empty());
  CHECK(test_hw::configuration.autoSleepMin == 0);

  // Source integration: all real capture consumers use the driver guard; deferred power work
  // goes to the existing API task and requests are retained if queueing fails.
  const auto apiSource = source("firmware/ai_smart_stick_v1/Api.cpp");
  const auto driverSource = source("firmware/ai_smart_stick_v1/Drivers.cpp");
  const auto mainSource = source("firmware/ai_smart_stick_v1/stick_main.cpp");
  CHECK(apiSource.find("httpd_queue_work(server, cameraPowerWork, nullptr)") != std::string::npos);
  CHECK(apiSource.find("camera::applyPendingPower();") != std::string::npos);
  CHECK(apiSource.find("camTryLock") == std::string::npos && apiSource.find("camUnlock") == std::string::npos);
  CHECK(driverSource.find("access.tryCapture()") != std::string::npos);
  CHECK(driverSource.find("access.tryPowerChange(power)") != std::string::npos);
  CHECK(mainSource.find("api::serviceCameraPower();") != std::string::npos);
  CHECK(mainSource.find("camera::powerDown()") == std::string::npos && mainSource.find("camera::powerUp()") == std::string::npos);

  std::printf("control integration: %d passed, %d failed\n", passes, fails);
  return fails ? 1 : 0;
}
