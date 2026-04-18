#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include <Preferences.h>
#include <time.h>
#include <math.h>

// ================= BUILD =================
#define FW_VERSION "1.0.0"

// ================= WIFI AP =================
const char* AP_SSID = "WaterTankMonitor";

// ================= FIREBASE =================
String firebaseBaseUrl = "https://waterlevelmonitor-95f66-default-rtdb.firebaseio.com/";

// ================= SENSOR =================
#define TRIG_PIN 17
#define ECHO_PIN 16

// ================= GLOBALS =================
WebServer server(80);
Preferences prefs;

String deviceId;
bool portalMode = false;

// saved config
String wifiSsid = "";
String wifiPass = "";
String tankName = "";

// config
float tankHeightCm = 126.0;
int sendIntervalMin = 1;
float threshold = 2.0;
float minValidDistance = 20.0;
int otaCheckIntervalMin = 10;

// runtime state
float currentDistance = -1.0;
float currentLevelPercent = -1.0;
float lastSentLevelPercent = -999.0;

unsigned long lastSensorCycleMs = 0;
unsigned long lastConfigFetchMs = 0;
unsigned long lastSystemInfoMs = 0;
unsigned long lastOtaCheckMs = 0;

// ================= DECLARATIONS =================
void setupDeviceId();
void loadLocalPreferences();
void saveLocalPreferences();

void connectOrStartAP();
bool connectToWiFi();
void startConfigPortal();
void setupPortalRoutes();
void setupNormalRoutes();

void initTime();
String getISOTime();
String getDateKey();
String getTimeKey();
String sanitizeFirebaseKey(String input);

bool firebaseRequest(const String &path, const String &method, const String &payload, String *response = nullptr);
bool firebaseGet(const String &path, String &response);
bool firebasePut(const String &path, const String &payload);
bool firebasePatch(const String &path, const String &payload);

void logEvent(const String &type, const String &message);
void logError(const String &message);

void uploadBootstrapConfig();
void uploadSystemInfo();
void fetchCloudConfig();

float readDistanceOnce();
float getStableDistance();
float getWaterLevelPercent(float distanceCm);
float getWaterHeightCm(float distanceCm);
bool shouldUpload(float levelPercent);
void uploadHistoricalData(float levelPercent, float distanceCm);
void uploadLiveData(float levelPercent, float distanceCm);
void processSensorCycle();

void checkForOtaUpdate();
bool performHttpOta(const String &url);

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  prefs.begin("wtank", false);

  setupDeviceId();
  loadLocalPreferences();

  Serial.println();
  Serial.println("================================");
  Serial.println("Water Tank Monitor");
  Serial.print("Device ID: ");
  Serial.println(deviceId);
  Serial.print("FW: ");
  Serial.println(FW_VERSION);
  Serial.println("================================");

  connectOrStartAP();

  if (!portalMode) {
    setupNormalRoutes();
    server.begin();

    initTime();
    fetchCloudConfig();
    uploadBootstrapConfig();
    uploadSystemInfo();
    logEvent("INFO", "System started");

    // first reading immediately after boot
    processSensorCycle();
    lastSensorCycleMs = millis();
  }
}

// ================= LOOP =================
void loop() {
  server.handleClient();

  if (portalMode) {
    delay(10);
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    logEvent("WARN", "WiFi disconnected");
    connectOrStartAP();

    if (!portalMode) {
      initTime();
      fetchCloudConfig();
      uploadSystemInfo();
    } else {
      return;
    }
  }

  unsigned long now = millis();

  if (now - lastConfigFetchMs >= 10UL * 60UL * 1000UL) {
    fetchCloudConfig();
    lastConfigFetchMs = now;
  }

  if (now - lastSystemInfoMs >= 30UL * 60UL * 1000UL) {
    uploadSystemInfo();
    lastSystemInfoMs = now;
  }

  if (now - lastOtaCheckMs >= (unsigned long)otaCheckIntervalMin * 60UL * 1000UL) {
    lastOtaCheckMs = now;
    checkForOtaUpdate();
  }

  if (now - lastSensorCycleMs >= (unsigned long)sendIntervalMin * 60UL * 1000UL) {
    lastSensorCycleMs = now;
    processSensorCycle();
  }

  delay(100);
}

// ================= DEVICE ID =================
void setupDeviceId() {
  uint64_t chipid = ESP.getEfuseMac();
  char buf[24];
  snprintf(buf, sizeof(buf), "device_%04X%08X",
           (uint16_t)(chipid >> 32),
           (uint32_t)chipid);
  deviceId = String(buf);
}

// ================= PREFS =================
void loadLocalPreferences() {
  wifiSsid = prefs.getString("wifi_ssid", "");
  wifiPass = prefs.getString("wifi_pass", "");
  tankName = prefs.getString("tank_name", "");

  tankHeightCm = prefs.getFloat("tank_h", 120.0);
  sendIntervalMin = prefs.getInt("interval", 15);
  threshold = prefs.getFloat("threshold", 2.0);
  minValidDistance = prefs.getFloat("min_dist", 20.0);
  otaCheckIntervalMin = prefs.getInt("ota_int", 10);

  lastSentLevelPercent = prefs.getFloat("last_lvl", -999.0);
}

void saveLocalPreferences() {
  prefs.putString("wifi_ssid", wifiSsid);
  prefs.putString("wifi_pass", wifiPass);
  prefs.putString("tank_name", tankName);

  prefs.putFloat("tank_h", tankHeightCm);
  prefs.putInt("interval", sendIntervalMin);
  prefs.putFloat("threshold", threshold);
  prefs.putFloat("min_dist", minValidDistance);
  prefs.putInt("ota_int", otaCheckIntervalMin);
}

// ================= WIFI / AP =================
void connectOrStartAP() {
  if (wifiSsid.length() == 0) {
    Serial.println("No WiFi saved -> starting AP");
    startConfigPortal();
    return;
  }

  if (connectToWiFi()) {
    portalMode = false;
    return;
  }

  Serial.println("WiFi failed -> starting AP");
  startConfigPortal();
}

bool connectToWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);
  delay(300);

  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());

  Serial.print("Connecting to WiFi");
  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 15) {
    delay(1000);
    Serial.print(".");
    retry++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected. IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println("Connection failed");
  return false;
}

void startConfigPortal() {
  portalMode = true;

  server.stop();
  delay(100);

  WiFi.disconnect(true, true);
  delay(300);

  WiFi.mode(WIFI_AP);
  delay(200);

  bool ok = WiFi.softAP(AP_SSID);

  if (!ok) {
    Serial.println("AP start failed");
  } else {
    Serial.println("AP started successfully");
  }

  Serial.print("SSID: ");
  Serial.println(AP_SSID);
  Serial.print("AP IP: ");
  Serial.println(WiFi.softAPIP());

  setupPortalRoutes();
  server.begin();
}

// ================= ROUTES =================
void setupPortalRoutes() {
  server.close();

  server.on("/", HTTP_GET, []() {
    String html =
      "<!DOCTYPE html><html><head>"
      "<meta name='viewport' content='width=device-width, initial-scale=1'>"
      "<title>watertank</title></head><body>"
      "<h2>Water Tank Configurator</h2>"
      "<p>Connect and configure WiFi</p>"
      "<form method='POST' action='/save'>"
      "<label>WiFi SSID</label><br><input name='ssid' required><br><br>"
      "<label>WiFi Password</label><br><input name='pass' type='password'><br><br>"
      "<label>Tank Name</label><br><input name='tank_name'><br><br>"
      "<label>Tank Height (cm)</label><br><input name='tank_height' value='120'><br><br>"
      "<label>Interval (min)</label><br><input name='interval' value='15'><br><br>"
      "<label>Threshold (%)</label><br><input name='threshold' value='2'><br><br>"
      "<label>Min Valid Distance (cm)</label><br><input name='min_dist' value='20'><br><br>"
      "<label>OTA Check Interval (min)</label><br><input name='ota_int' value='10'><br><br>"
      "<button type='submit'>Save & Restart</button>"
      "</form>"
      "</body></html>";
    server.send(200, "text/html", html);
  });

  server.on("/save", HTTP_POST, []() {
    wifiSsid = server.arg("ssid");
    wifiPass = server.arg("pass");
    tankName = server.arg("tank_name");

    if (server.arg("tank_height").length()) tankHeightCm = server.arg("tank_height").toFloat();
    if (server.arg("interval").length()) sendIntervalMin = server.arg("interval").toInt();
    if (server.arg("threshold").length()) threshold = server.arg("threshold").toFloat();
    if (server.arg("min_dist").length()) minValidDistance = server.arg("min_dist").toFloat();
    if (server.arg("ota_int").length()) otaCheckIntervalMin = server.arg("ota_int").toInt();

    saveLocalPreferences();

    server.send(200, "text/html", "<h3>Saved successfully. Restarting...</h3>");
    delay(1500);
    ESP.restart();
  });

  server.on("/reset", HTTP_GET, []() {
    prefs.clear();
    server.send(200, "text/plain", "Preferences cleared. Restarting...");
    delay(1000);
    ESP.restart();
  });

  server.onNotFound([]() {
    server.send(200, "text/plain", "Open http://192.168.4.1/");
  });
}

void setupNormalRoutes() {
  server.close();

  server.on("/", HTTP_GET, []() {
    server.send(200, "text/plain", "ESP32 Water Tank Monitor Running");
  });

  server.on("/level", HTTP_GET, []() {
    DynamicJsonDocument doc(256);
    doc["device_id"] = deviceId;
    doc["firmware"] = FW_VERSION;
    doc["tank_name"] = tankName;
    doc["level_percent"] = round(currentLevelPercent * 10.0) / 10.0;
    doc["water_height_cm"] = round(getWaterHeightCm(currentDistance) * 10.0) / 10.0;
    doc["distance_cm"] = round(currentDistance * 10.0) / 10.0;
    doc["updated_at"] = getISOTime();

    String out;
    serializeJson(doc, out);
    server.send(200, "application/json", out);
  });

  server.on("/reconfigure", HTTP_GET, []() {
    prefs.remove("wifi_ssid");
    prefs.remove("wifi_pass");
    server.send(200, "text/plain", "WiFi cleared. Restarting...");
    delay(1000);
    ESP.restart();
  });
}

// ================= TIME =================
String getISOTime() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return "unknown-time";
  char buf[25];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &timeinfo);
  return String(buf);
}

String getDateKey() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return "unknown-date";
  char buf[12];
  strftime(buf, sizeof(buf), "%d-%m-%Y", &timeinfo);
  return String(buf);
}

String getTimeKey() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return String(millis());
  char buf[10];
  strftime(buf, sizeof(buf), "%H-%M-%S", &timeinfo);
  return String(buf);
}

String sanitizeFirebaseKey(String input) {
  input.replace(".", "-");
  input.replace("#", "-");
  input.replace("$", "-");
  input.replace("[", "(");
  input.replace("]", ")");
  input.replace("/", "-");
  input.replace(":", "-");
  return input;
}

void initTime() {
  configTime(19800, 0, "pool.ntp.org", "time.nist.gov");
}

// ================= FIREBASE =================
bool firebaseRequest(const String &path, const String &method, const String &payload, String *response) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = firebaseBaseUrl + path;

  if (!http.begin(client, url)) return false;

  http.addHeader("Content-Type", "application/json");

  int code = -1;

  if (method == "GET") {
    code = http.GET();
    if (response && code == 200) *response = http.getString();
  } else if (method == "PUT") {
    code = http.PUT(payload);
  } else if (method == "PATCH") {
    code = http.sendRequest("PATCH", payload);
  }

  http.end();

  Serial.print("Firebase ");
  Serial.print(method);
  Serial.print(" ");
  Serial.print(path);
  Serial.print(" -> ");
  Serial.println(code);

  return (code == 200);
}

bool firebaseGet(const String &path, String &response) {
  return firebaseRequest(path, "GET", "", &response);
}

bool firebasePut(const String &path, const String &payload) {
  return firebaseRequest(path, "PUT", payload, nullptr);
}

bool firebasePatch(const String &path, const String &payload) {
  return firebaseRequest(path, "PATCH", payload, nullptr);
}

// ================= LOGGING =================
void logEvent(const String &type, const String &message) {
  Serial.print("[");
  Serial.print(type);
  Serial.print("] ");
  Serial.println(message);

  if (WiFi.status() != WL_CONNECTED) return;

  String key = sanitizeFirebaseKey(getISOTime());
  String path = "devices/" + deviceId + "/logs.json";

  DynamicJsonDocument doc(256);
  doc[key]["type"] = type;
  doc[key]["message"] = message;
  doc[key]["time"] = getISOTime();

  String json;
  serializeJson(doc, json);
  firebasePatch(path, json);
}

void logError(const String &message) {
  Serial.print("[ERROR] ");
  Serial.println(message);

  if (WiFi.status() != WL_CONNECTED) return;

  String key = sanitizeFirebaseKey(getISOTime());
  String path = "devices/" + deviceId + "/errors.json";

  DynamicJsonDocument doc(256);
  doc[key]["type"] = "ERROR";
  doc[key]["message"] = message;
  doc[key]["time"] = getISOTime();

  String json;
  serializeJson(doc, json);
  firebasePatch(path, json);
}

// ================= CLOUD =================
void uploadBootstrapConfig() {
  if (WiFi.status() != WL_CONNECTED) return;

  DynamicJsonDocument doc(512);
  doc["device_id"] = deviceId;
  doc["firmware"] = FW_VERSION;
  doc["tank_name"] = tankName;
  doc["wifi_ssid"] = wifiSsid;
  doc["tank_height_cm"] = tankHeightCm;
  doc["interval_min"] = sendIntervalMin;
  doc["threshold"] = threshold;
  doc["min_valid_distance"] = minValidDistance;
  doc["ota_check_interval_min"] = otaCheckIntervalMin;
  doc["provisioned_at"] = getISOTime();

  String json;
  serializeJson(doc, json);

  firebasePut("devices/" + deviceId + "/bootstrap.json", json);
}

void uploadSystemInfo() {
  if (WiFi.status() != WL_CONNECTED) return;

  DynamicJsonDocument doc(512);
  doc["device_id"] = deviceId;
  doc["firmware"] = FW_VERSION;
  doc["ip"] = WiFi.localIP().toString();
  doc["mac"] = WiFi.macAddress();
  doc["ssid"] = WiFi.SSID();
  doc["rssi"] = WiFi.RSSI();
  doc["heap"] = ESP.getFreeHeap();
  doc["flash_size"] = ESP.getFlashChipSize();
  doc["sdk_version"] = ESP.getSdkVersion();
  doc["uptime_ms"] = millis();
  doc["time"] = getISOTime();

  String json;
  serializeJson(doc, json);

  if (firebasePut("devices/" + deviceId + "/systeminfo.json", json)) {
    logEvent("INFO", "System info updated");
  }
}

void fetchCloudConfig() {
  if (WiFi.status() != WL_CONNECTED) return;

  String response;
  if (!firebaseGet("devices/" + deviceId + "/config.json", response)) return;
  if (response == "null" || response.length() == 0) return;

  DynamicJsonDocument doc(512);
  DeserializationError err = deserializeJson(doc, response);
  if (err) {
    logError("Cloud config parse failed");
    return;
  }

  if (!doc["tank_height"].isNull()) tankHeightCm = doc["tank_height"].as<float>();
  if (!doc["interval_min"].isNull()) sendIntervalMin = doc["interval_min"].as<int>();
  if (!doc["threshold"].isNull()) threshold = doc["threshold"].as<float>();
  if (!doc["min_valid_distance"].isNull()) minValidDistance = doc["min_valid_distance"].as<float>();
  if (!doc["tank_name"].isNull()) tankName = doc["tank_name"].as<String>();
  if (!doc["ota_check_interval_min"].isNull()) otaCheckIntervalMin = doc["ota_check_interval_min"].as<int>();

  if (sendIntervalMin < 1) sendIntervalMin = 1;
  if (threshold < 0.1) threshold = 0.1;
  if (otaCheckIntervalMin < 1) otaCheckIntervalMin = 1;

  saveLocalPreferences();
  logEvent("INFO", "Cloud config loaded");
}

// ================= SENSOR =================
float readDistanceOnce() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(5);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 40000);
  if (duration == 0) return -1.0;

  float d = duration * 0.0343f / 2.0f;
  if (d < minValidDistance || d > 500.0f) return -1.0;

  return d;
}

float getStableDistance() {
  float arr[7];
  int count = 0;

  for (int i = 0; i < 7; i++) {
    float d = readDistanceOnce();
    if (d > 0) arr[count++] = d;
    delay(120);
  }

  if (count == 0) return -1.0;

  for (int i = 0; i < count - 1; i++) {
    for (int j = i + 1; j < count; j++) {
      if (arr[j] < arr[i]) {
        float t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
      }
    }
  }

  return arr[count / 2];
}

float getWaterLevelPercent(float distanceCm) {
  float level = ((tankHeightCm - distanceCm) / tankHeightCm) * 100.0f;
  if (level < 0) level = 0;
  if (level > 100) level = 100;
  return level;
}

float getWaterHeightCm(float distanceCm) {
  float waterHeight = tankHeightCm - distanceCm;
  if (waterHeight < 0) waterHeight = 0;
  if (waterHeight > tankHeightCm) waterHeight = tankHeightCm;
  return waterHeight;
}

bool shouldUpload(float levelPercent) {
  if (lastSentLevelPercent < -100.0) return true;
  return fabs(levelPercent - lastSentLevelPercent) >= threshold;
}

void uploadHistoricalData(float levelPercent, float distanceCm) {
  String dateKey = getDateKey();
  String timeKey = getTimeKey();
  String path = "devices/" + deviceId + "/history/" + dateKey + ".json";

  DynamicJsonDocument doc(256);
  doc[timeKey]["level_percent"] = round(levelPercent * 10.0) / 10.0;
  doc[timeKey]["water_height_cm"] = round(getWaterHeightCm(distanceCm) * 10.0) / 10.0;
  doc[timeKey]["distance_cm"] = round(distanceCm * 10.0) / 10.0;
  doc[timeKey]["timestamp"] = getISOTime();

  String json;
  serializeJson(doc, json);

  Serial.println("---- HISTORICAL UPLOAD ----");
  Serial.println("Path: " + path);
  Serial.println("Payload: " + json);

  if (!firebasePatch(path, json)) {
    logError("Historical upload failed");
  }
}

void uploadLiveData(float levelPercent, float distanceCm) {
  String path = "devices/" + deviceId + "/tank_live.json";

  DynamicJsonDocument doc(256);
  doc["level_percent"] = round(levelPercent * 10.0) / 10.0;
  doc["water_height_cm"] = round(getWaterHeightCm(distanceCm) * 10.0) / 10.0;
  doc["distance_cm"] = round(distanceCm * 10.0) / 10.0;
  doc["updated_at"] = getISOTime();
  doc["firmware"] = FW_VERSION;

  String json;
  serializeJson(doc, json);

  Serial.println("---- LIVE UPLOAD ----");
  Serial.println("Path: " + path);
  Serial.println("Payload: " + json);

  if (!firebasePut(path, json)) {
    logError("Live upload failed");
  }
}

void processSensorCycle() {
  float distance = getStableDistance();

  if (distance < 0) {
    logError("Sensor invalid reading");
    return;
  }

  currentDistance = distance;
  currentLevelPercent = getWaterLevelPercent(distance);

  Serial.print("Distance: ");
  Serial.print(currentDistance, 1);
  Serial.print(" cm | Water Height: ");
  Serial.print(getWaterHeightCm(currentDistance), 1);
  Serial.print(" cm | Level: ");
  Serial.print(currentLevelPercent, 1);
  Serial.println("%");

  //if (shouldUpload(currentLevelPercent)) {
  if(true){
    Serial.println("Upload condition met");
    uploadHistoricalData(currentLevelPercent, currentDistance);
    uploadLiveData(currentLevelPercent, currentDistance);

    lastSentLevelPercent = currentLevelPercent;
    prefs.putFloat("last_lvl", lastSentLevelPercent);

    logEvent("INFO", "Tank data uploaded");
  } else {
    Serial.println("Upload skipped: no significant change");
    logEvent("INFO", "No significant change, upload skipped");
  }
}

// ================= OTA =================
void checkForOtaUpdate() {
  if (WiFi.status() != WL_CONNECTED) return;

  String response;
  bool ok = firebaseGet("devices/" + deviceId + "/firmware.json", response);

  if (!ok || response == "null" || response.length() == 0) {
    ok = firebaseGet("firmware.json", response);
  }

  if (!ok || response == "null" || response.length() == 0) {
    Serial.println("No OTA config found");
    return;
  }

  DynamicJsonDocument doc(512);
  DeserializationError err = deserializeJson(doc, response);
  if (err) {
    logError("OTA config parse failed");
    return;
  }

  String latestVersion = doc["latest_version"] | "";
  String url = doc["url"] | "";
  bool enabled = doc["enabled"] | true;

  Serial.println("---- OTA CHECK ----");
  Serial.print("Current FW: ");
  Serial.println(FW_VERSION);
  Serial.print("Latest FW: ");
  Serial.println(latestVersion);
  Serial.print("Enabled: ");
  Serial.println(enabled ? "true" : "false");
  Serial.print("URL: ");
  Serial.println(url);

  if (!enabled) return;
  if (latestVersion.length() == 0 || url.length() == 0) return;
  if (latestVersion == String(FW_VERSION)) {
    Serial.println("Already on latest firmware");
    return;
  }

  logEvent("INFO", "OTA update found: " + latestVersion);

  if (performHttpOta(url)) {
    logEvent("INFO", "OTA successful, rebooting");
    delay(1000);
    ESP.restart();
  } else {
    logError("OTA failed");
  }
}

bool performHttpOta(const String &url) {
  WiFiClientSecure client;
  client.setInsecure();

  httpUpdate.rebootOnUpdate(false);

  t_httpUpdate_return ret = httpUpdate.update(client, url);

  switch (ret) {
    case HTTP_UPDATE_FAILED:
      Serial.printf("OTA failed (%d): %s\n",
                    httpUpdate.getLastError(),
                    httpUpdate.getLastErrorString().c_str());
      return false;

    case HTTP_UPDATE_NO_UPDATES:
      Serial.println("No OTA updates");
      return false;

    case HTTP_UPDATE_OK:
      Serial.println("OTA success");
      return true;
  }

  return false;
}