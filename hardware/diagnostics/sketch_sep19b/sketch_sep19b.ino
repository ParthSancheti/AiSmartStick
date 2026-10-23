// Historical bench diagnostic sketch supplied by the author. Wi-Fi credentials redacted.
// NOT the protocol-v1 firmware used by the current Android apps. See hardware/README.md.
#include "esp_camera.h"
#include <WiFi.h>
#include <WebServer.h>
#include "esp_http_server.h"
#include <Wire.h>
#include <Adafruit_INA219.h> // नई बैटरी लाइब्रेरी

// --- WIFI CREDENTIALS ---
const char *ssid = "YOUR_2_4_GHZ_WIFI";
const char *password = "YOUR_WIFI_PASSWORD";

// --- PIN DEFINITIONS ---
#define TRIG_PIN 13
#define ECHO_PIN 12
#define MOTOR_PIN 2
#define BUTTON_PIN 3
#define SDA_PIN 14
#define SCL_PIN 15

// --- CAMERA PINS (AI-THINKER) ---
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

WebServer server(80);
Adafruit_INA219 ina219; // INA219 ऑब्जेक्ट

// Global Variables for Sensors
float distance_cm = 0;
float pitch = 0;
float roll = 0;
int button_state = 1;
int battery_pct = 0;
bool is_charging = false;

// ==========================================
// HTML & JS FRONTEND (Battery UI Added)
// ==========================================
const char *html_page = R"=====(
<!DOCTYPE HTML><html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Smart-J Diagnostic Dashboard</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #121212; color: #ffffff; margin: 0; padding: 20px; text-align: center; }
    h2 { color: #00ffcc; text-transform: uppercase; letter-spacing: 2px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; max-width: 1000px; margin: auto; }
    .card { background: #1e1e1e; padding: 20px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); border: 1px solid #333; }
    .card h3 { margin-top: 0; color: #aaa; font-size: 14px; text-transform: uppercase; }
    img { max-width: 100%; border-radius: 8px; background: #000; min-height: 200px; }
    canvas { background: #0a0a0a; border-radius: 50%; border: 2px solid #00ffcc; box-shadow: 0 0 15px rgba(0,255,204,0.3); }
    .scene { width: 150px; height: 150px; perspective: 400px; margin: 20px auto; }
    .cube { width: 100%; height: 100%; position: relative; transform-style: preserve-3d; transition: transform 0.1s; }
    .cube__face { position: absolute; width: 150px; height: 150px; background: rgba(0, 255, 204, 0.2); border: 2px solid #00ffcc; line-height: 150px; font-weight: bold; font-size: 20px; color: white; text-align: center; }
    .cube__face--front  { transform: rotateY(  0deg) translateZ(75px); }
    .cube__face--right  { transform: rotateY( 90deg) translateZ(75px); }
    .cube__face--back   { transform: rotateY(180deg) translateZ(75px); }
    .cube__face--left   { transform: rotateY(-90deg) translateZ(75px); }
    .cube__face--top    { transform: rotateX( 90deg) translateZ(75px); }
    .cube__face--bottom { transform: rotateX(-90deg) translateZ(75px); }
    button { background: #00ffcc; border: none; padding: 10px 15px; margin: 5px; border-radius: 6px; font-weight: bold; cursor: pointer; color: #000; transition: 0.3s; }
    button:hover { background: #00ccaa; }
    .btn-status { padding: 15px; border-radius: 8px; font-size: 18px; font-weight: bold; margin-top: 20px; }
    .btn-off { background: #333; color: #fff; }
    .btn-on { background: #ff3366; color: #fff; box-shadow: 0 0 15px #ff3366; }
    .val { font-size: 24px; font-weight: bold; color: #00ffcc; }
    .charging-alert { color: #ffeb3b; font-weight: bold; font-size: 18px; margin-top: 10px; text-shadow: 0 0 10px #ffeb3b; display: none; }
    .battery-icon { font-size: 40px; margin: 10px 0; }
  </style>
</head>
<body>
  <h2>Smart-J Diagnostic Hub</h2>
  <div class="grid">
    
    <div class="card">
      <h3>Power System</h3>
      <div id="bat-icon" class="battery-icon">🔋</div>
      <p>Battery: <span id="bat-val" class="val">--</span>%</p>
      <div id="charging-status" class="charging-alert">⚡ CHARGING ACTIVE</div>
    </div>

    <div class="card">
      <h3>AI Vision (Webcam)</h3>
      <img src="" id="video-stream" alt="Live Feed">
    </div>
    
    <div class="card">
      <h3>Ultrasonic Radar</h3>
      <canvas id="radar" width="200" height="200"></canvas>
      <p>Distance: <span id="dist-val" class="val">--</span> cm</p>
    </div>

    <div class="card">
      <h3>Gyroscope (3D MPU6050)</h3>
      <div class="scene">
        <div class="cube" id="cube">
          <div class="cube__face cube__face--front">Stick</div>
          <div class="cube__face cube__face--back"></div>
          <div class="cube__face cube__face--right"></div>
          <div class="cube__face cube__face--left"></div>
          <div class="cube__face cube__face--top">Top</div>
          <div class="cube__face cube__face--bottom"></div>
        </div>
      </div>
      <p>Pitch: <span id="pitch-val">0</span>° | Roll: <span id="roll-val">0</span>°</p>
    </div>

    <div class="card">
      <h3>Haptics & Input</h3>
      <button onclick="triggerMotor(1)">Pattern 1: Danger</button>
      <button onclick="triggerMotor(2)">Pattern 2: Alert</button>
      <button onclick="triggerMotor(3)">Pattern 3: Tap</button>
      <div id="smart-btn" class="btn-status btn-off">SMART BUTTON: UNPRESSED</div>
    </div>
  </div>

  <script>
    window.onload = () => {
      document.getElementById('video-stream').src = "http://" + window.location.hostname + ":81/stream";
    };

    const canvas = document.getElementById('radar');
    const ctx = canvas.getContext('2d');
    let angle = 0;

    const drawRadar = (distance) => {
      ctx.fillStyle = 'rgba(10, 10, 10, 0.1)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const radius = 90;
      
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = '#333';
      ctx.stroke();

      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = '#00ffcc';
      ctx.stroke();
      angle += 0.1;

      if(distance > 0 && distance < 400) {
        const blipRadius = (distance / 400) * radius;
        const bx = cx + Math.cos(angle - 0.5) * blipRadius;
        const by = cy + Math.sin(angle - 0.5) * blipRadius;
        ctx.beginPath();
        ctx.arc(bx, by, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ff3366';
        ctx.fill();
      }
    };

    const triggerMotor = (pattern) => {
      fetch('/motor?pattern=' + pattern).catch(e => console.log(e));
    };

    setInterval(() => {
      fetch('/data')
        .then(response => response.json())
        .then(data => {
          // Update Existing Sensors
          document.getElementById('dist-val').innerText = data.distance;
          document.getElementById('pitch-val').innerText = data.pitch;
          document.getElementById('roll-val').innerText = data.roll;
          drawRadar(data.distance);
          document.getElementById('cube').style.transform = `rotateX(${data.pitch}deg) rotateY(${data.roll}deg)`;

          // Update Button
          const btnUI = document.getElementById('smart-btn');
          if (data.button === 0) {
            btnUI.className = "btn-status btn-on";
            btnUI.innerText = "SMART BUTTON: PRESSED!";
          } else {
            btnUI.className = "btn-status btn-off";
            btnUI.innerText = "SMART BUTTON: UNPRESSED";
          }

          // Update Battery
          document.getElementById('bat-val').innerText = data.battery;
          const chargeUI = document.getElementById('charging-status');
          const batIcon = document.getElementById('bat-icon');
          if (data.charging) {
            chargeUI.style.display = "block";
            batIcon.innerText = "⚡";
          } else {
            chargeUI.style.display = "none";
            batIcon.innerText = data.battery < 20 ? "🪫" : "🔋";
          }

        }).catch(e => console.log(e));
    }, 300);
  </script>
</body>
</html>
)=====";

// ==========================================
// SENSOR READING LOGIC
// ==========================================
void readUltrasonic() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  distance_cm = (duration == 0) ? -1 : (duration * 0.0343) / 2;
}

void readMPU6050() {
  Wire.beginTransmission(0x68);
  Wire.write(0x3B);
  Wire.endTransmission(false);
  Wire.requestFrom((uint16_t)0x68, (uint8_t)6, true);
  if (Wire.available() == 6) {
    int16_t ax = Wire.read() << 8 | Wire.read();
    int16_t ay = Wire.read() << 8 | Wire.read();
    int16_t az = Wire.read() << 8 | Wire.read();
    pitch = -(atan2(ax, sqrt(ay * ay + az * az)) * 180.0) / PI;
    roll = (atan2(ay, az) * 180.0) / PI;
  }
}

void readBattery() {
  // चूँकि बैटरी Vin- पर कनेक्टेड है, हम Bus Voltage पढ़ेंगे
  float voltage = ina219.getBusVoltage_V();
  
  if (voltage >= 4.25) {
    battery_pct = 100;
    is_charging = true;
  } else {
    is_charging = false;
    battery_pct = ((voltage - 3.2) / (4.2 - 3.2)) * 100;
    if (battery_pct > 100) battery_pct = 100;
    if (battery_pct < 0) battery_pct = 0;
  }
}

// ==========================================
// WEB SERVER ENDPOINTS
// ==========================================
void handleRoot() {
  server.send(200, "text/html", html_page);
}

void handleData() {
  readUltrasonic();
  readMPU6050();
  readBattery();
  button_state = digitalRead(BUTTON_PIN);

  // JSON कंस्ट्रक्शन (बैटरी और चार्जिंग डेटा जोड़ा गया)
  String json = "{";
  json += "\"distance\":" + String(distance_cm) + ",";
  json += "\"pitch\":" + String((int)pitch) + ",";
  json += "\"roll\":" + String((int)roll) + ",";
  json += "\"button\":" + String(button_state) + ",";
  json += "\"battery\":" + String(battery_pct) + ",";
  json += "\"charging\":" + String(is_charging ? "true" : "false");
  json += "}";
  server.send(200, "application/json", json);
}

void handleMotor() {
  if (server.hasArg("pattern")) {
    int pattern = server.arg("pattern").toInt();
    if (pattern == 1) { 
      digitalWrite(MOTOR_PIN, HIGH); delay(800); digitalWrite(MOTOR_PIN, LOW);
    } else if (pattern == 2) { 
      digitalWrite(MOTOR_PIN, HIGH); delay(200); digitalWrite(MOTOR_PIN, LOW); delay(150);
      digitalWrite(MOTOR_PIN, HIGH); delay(200); digitalWrite(MOTOR_PIN, LOW);
    } else if (pattern == 3) { 
      digitalWrite(MOTOR_PIN, HIGH); delay(150); digitalWrite(MOTOR_PIN, LOW);
    }
  }
  server.send(200, "text/plain", "OK");
}

// Minimal MJPEG Stream Handler (Software JPEG Hack included)
httpd_handle_t stream_httpd = NULL;
esp_err_t stream_handler(httpd_req_t *req) {
  camera_fb_t *fb = NULL;
  esp_err_t res = ESP_OK;
  size_t _jpg_buf_len = 0;
  uint8_t *_jpg_buf = NULL;
  char part_buf[64];
  
  res = httpd_resp_set_type(req, "multipart/x-mixed-replace;boundary=123456789000000000000987654321");
  if (res != ESP_OK) return res;

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) {
      res = ESP_FAIL;
      break;
    }

    bool jpeg_converted = frame2jpg(fb, 20, &_jpg_buf, &_jpg_buf_len);
    esp_camera_fb_return(fb);

    if (!jpeg_converted) {
      res = ESP_FAIL;
      break;
    }

    size_t hlen = snprintf(part_buf, 64, "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", _jpg_buf_len);
    res = httpd_resp_send_chunk(req, (const char *)part_buf, hlen);
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char *)_jpg_buf, _jpg_buf_len);
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, "\r\n--123456789000000000000987654321\r\n", 37);

    free(_jpg_buf);
    if (res != ESP_OK) break;
  }
  return res;
}

void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 81; 
  httpd_uri_t stream_uri = { .uri = "/stream", .method = HTTP_GET, .handler = stream_handler, .user_ctx = NULL };
  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
  }
}

// ==========================================
// SETUP & LOOP
// ==========================================
void setup() {
  Serial.begin(115200);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(MOTOR_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  // I2C बस चालू करें (SDA और SCL पर MPU6050 और INA219 दोनों चलेंगे)
  Wire.begin(SDA_PIN, SCL_PIN);

  // INA219 इनिशियलाइज़ करें
  if (!ina219.begin()) {
    Serial.println("Failed to find INA219 chip");
  }

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 10000000;
  config.pixel_format = PIXFORMAT_RGB565;
  config.frame_size = FRAMESIZE_QVGA;
  config.jpeg_quality = 20;
  config.fb_count = 1;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.println("Camera init failed!");
    return;
  }

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected!");
  Serial.print("OPEN THIS LINK IN YOUR BROWSER: http://");
  Serial.println(WiFi.localIP());

  server.on("/", handleRoot);
  server.on("/data", handleData);
  server.on("/motor", handleMotor);
  server.begin();
  
  startCameraServer();
}

void loop() {
  server.handleClient();
}