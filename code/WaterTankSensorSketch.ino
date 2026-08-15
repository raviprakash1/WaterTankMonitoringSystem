#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_wifi.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include <Preferences.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <time.h>
#include <math.h>

// ================= BUILD =================
#define FW_VERSION "1.2.0"

// ================= WIFI AP =================
const char* AP_SSID = "WaterTankMonitor";

// ================= FIREBASE =================
String firebaseBaseUrl = "https://waterlevelmonitor-95f66-default-rtdb.firebaseio.com/";

// ================= SENSOR =================
#define TRIG_PIN 17
#define ECHO_PIN 16
#define TDS_PIN 34          // Analog TDS A0 (ADC1 — safe with WiFi)
#define TEMP_PIN 4          // DS18B20 data (4.7 kΩ pull-up to 3V3, not 5 V)
#define TDS_VREF 3.3f
#define TDS_ADC_MAX 4095.0f
#define TDS_SAMPLES 30
#define TDS_MAX_PPM 1000.0f
#define CONFIG_FETCH_MS (60UL * 1000UL)

// ================= GLOBALS =================
WebServer server(80);
Preferences prefs;
OneWire oneWire(TEMP_PIN);
DallasTemperature tempSensor(&oneWire);

String deviceId;
bool portalMode = false;

// saved config
String wifiSsid = "";
String wifiPass = "";
String tankName = "";

// config
float tankHeightCm = 160.0;
int sendIntervalSec = 1;
float threshold = 2.0;
float minValidDistance = 20.0;
int otaCheckIntervalMin = 5;  // check Firebase for new builds often

// runtime state
float currentDistance = -1.0;
float currentLevelPercent = -1.0;
float currentTdsPpm = -1.0;
float currentTempC = -127.0;
float lastSentLevelPercent = -999.0;

unsigned long lastSensorCycleMs = 0;
unsigned long lastConfigFetchMs = 0;
unsigned long lastSystemInfoMs = 0;
unsigned long lastOtaCheckMs = 0;
unsigned long lastWifiReconnectMs = 0;
bool wifiWasConnected = false;
volatile bool wifiDisconnectFlag = false;
int wifiFailStreak = 0;
int otaFailStreak = 0;
unsigned long lastOtaFailMs = 0;

// Keep trying forever while credentials exist (never trap in AP after provision).
const unsigned long WIFI_RETRY_WAIT_MS = 500UL;
const int WIFI_HARD_RESET_EVERY_TRIES = 60;  // ~30s of failing, then radio cycle
const int WIFI_SCAN_EVERY_RESETS = 3;

// ================= DECLARATIONS =================
void setupDeviceId();
void loadLocalPreferences();
void saveLocalPreferences();

void connectOrStartAP();
bool connectToWiFi();
bool ensureWiFiConnected();
void hardResetWifiRadio();
void applyWifiRadioSettings();
void logNearbyWifiNetworks();
void onWifiArduinoEvent(WiFiEvent_t event);
void startConfigPortal();
void setupPortalRoutes();
void setupNormalRoutes();
void onWiFiConnected();
unsigned long wifiReconnectIntervalMs();

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
void writeCloudConfig();

bool isValidTemperature(float tempC);
float readTemperatureC();
float readTdsPpm(float tempC);
void addQualityFields(JsonObject obj);
String formatQualityMessage();

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
String normalizeOtaUrl(String url);
bool isNewerFirmware(const String &candidate, const String &current);
bool parseOtaManifest(const String &response, String &latestVersion, String &url, bool &enabled);
bool loadOtaManifest(String &latestVersion, String &url, bool &enabled);

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  analogReadResolution(12);
  analogSetPinAttenuation(TDS_PIN, ADC_11db);
  pinMode(TDS_PIN, INPUT);

  tempSensor.begin();
  tempSensor.setResolution(12);

  prefs.begin("wtank", false);

  setupDeviceId();
  loadLocalPreferences();

  // Station sleep often causes sticky disconnects that need a power cycle.
  WiFi.persistent(true);
  WiFi.setAutoReconnect(true);
  applyWifiRadioSettings();
  WiFi.onEvent(onWifiArduinoEvent);

  Serial.println();
  Serial.println("================================");
  Serial.println("Water Tank Monitor");
  Serial.print("Device ID: ");
  Serial.println(deviceId);
  Serial.print("FW: ");
  Serial.println(FW_VERSION);
  Serial.print("DS18B20 devices: ");
  Serial.println(tempSensor.getDeviceCount());
  Serial.println("Config source: Firebase (interval_sec default 1)");
  Serial.println("================================");

  connectOrStartAP();

  if (!portalMode) {
    setupNormalRoutes();
    server.begin();

    if (WiFi.status() == WL_CONNECTED) {
      initTime();
      fetchCloudConfig();
      uploadBootstrapConfig();
      uploadSystemInfo();
      logEvent("INFO", "System started");
      checkForOtaUpdate();
      lastOtaCheckMs = millis();
      processSensorCycle();
    } else {
      Serial.println("Boot without WiFi — sensor/cloud wait for reconnect");
    }
    lastSensorCycleMs = millis();
  }
}

// ================= LOOP =================
void loop() {
  server.handleClient();

  // Config portal only when no credentials were saved (first setup).
  // If SSID exists, never stay stuck in AP — keep trying STA forever.
  if (portalMode) {
    if (wifiSsid.length() > 0) {
      unsigned long nowPortal = millis();
      if (nowPortal - lastWifiReconnectMs >= wifiReconnectIntervalMs()) {
        lastWifiReconnectMs = nowPortal;
        Serial.println("Leaving AP portal — retrying saved WiFi…");
        if (connectToWiFi()) {
          portalMode = false;
          server.stop();
          delay(50);
          setupNormalRoutes();
          server.begin();
          onWiFiConnected();
          logEvent("INFO", "WiFi reconnected (left AP portal)");
        } else {
          wifiFailStreak++;
          if (wifiFailStreak >= WIFI_SCAN_EVERY_RESETS) {
            hardResetWifiRadio();
            wifiFailStreak = 0;
          }
        }
      }
    }
    delay(10);
    return;
  }

  if (!ensureWiFiConnected()) {
    // Stay in station mode and retry forever; never open AP once provisioned.
    delay(100);
    return;
  }

  unsigned long now = millis();

  if (now - lastConfigFetchMs >= CONFIG_FETCH_MS) {
    fetchCloudConfig();
    lastConfigFetchMs = now;
  }

  if (now - lastSystemInfoMs >= 30UL * 60UL * 1000UL) {
    uploadSystemInfo();
    lastSystemInfoMs = now;
  }

  // After a failed OTA, wait a bit before hammering GitHub again.
  unsigned long otaBackoffMs = (otaFailStreak > 0)
      ? min(30UL * 60UL * 1000UL, (unsigned long)otaFailStreak * 2UL * 60UL * 1000UL)
      : 0;
  unsigned long otaDueMs = max((unsigned long)otaCheckIntervalMin * 60UL * 1000UL, otaBackoffMs);
  if (now - lastOtaCheckMs >= otaDueMs) {
    lastOtaCheckMs = now;
    checkForOtaUpdate();
  }

  unsigned long sensorIntervalMs = (unsigned long)sendIntervalSec * 1000UL;
  if (sensorIntervalMs < 1000UL) sensorIntervalMs = 1000UL;
  if (now - lastSensorCycleMs >= sensorIntervalMs) {
    lastSensorCycleMs = now;
    processSensorCycle();
  }

  delay(sendIntervalSec <= 2 ? 10 : 100);
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

  tankHeightCm = prefs.getFloat("tank_h", 160.0);
  sendIntervalSec = prefs.getInt("int_sec", 1);
  threshold = prefs.getFloat("threshold", 2.0);
  minValidDistance = prefs.getFloat("min_dist", 20.0);
  otaCheckIntervalMin = prefs.getInt("ota_int", 5);

  lastSentLevelPercent = prefs.getFloat("last_lvl", -999.0);
}

void saveLocalPreferences() {
  prefs.putString("wifi_ssid", wifiSsid);
  prefs.putString("wifi_pass", wifiPass);
  prefs.putString("tank_name", tankName);

  prefs.putFloat("tank_h", tankHeightCm);
  prefs.putInt("int_sec", sendIntervalSec);
  prefs.putFloat("threshold", threshold);
  prefs.putFloat("min_dist", minValidDistance);
  prefs.putInt("ota_int", otaCheckIntervalMin);
}

// ================= WIFI / AP =================
unsigned long wifiReconnectIntervalMs() {
  return 5000UL;
}

void onWifiArduinoEvent(WiFiEvent_t event) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      wifiDisconnectFlag = true;
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      wifiDisconnectFlag = false;
      wifiFailStreak = 0;
      break;
    default:
      break;
  }
}

void applyWifiRadioSettings() {
  // RX gain is not software-adjustable on ESP32. These settings make a weak
  // 2.4 GHz AP more likely to associate: no sleep, max TX, 20 MHz, keep 802.11b.
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  esp_wifi_set_max_tx_power(78);  // 0.25 dBm units; 78 = 19.5 dBm

  wifi_mode_t mode = WiFi.getMode();
  if (mode == WIFI_MODE_NULL) return;

  wifi_interface_t iface = (mode == WIFI_MODE_AP || mode == WIFI_MODE_APSTA)
      ? WIFI_IF_AP
      : WIFI_IF_STA;
  esp_wifi_set_protocol(iface, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
  esp_wifi_set_bandwidth(iface, WIFI_BW_HT20);
}

void logNearbyWifiNetworks() {
  Serial.println("Scanning 2.4 GHz networks (check RSSI for your AP)…");
  int n = WiFi.scanNetworks(/*async=*/false, /*show_hidden=*/true);
  if (n <= 0) {
    Serial.println("No 2.4 GHz APs heard. ESP32 cannot see 5 GHz SSIDs.");
    WiFi.scanDelete();
    return;
  }
  for (int i = 0; i < n; i++) {
    Serial.print("  ");
    Serial.print(WiFi.SSID(i));
    Serial.print("  RSSI ");
    Serial.print(WiFi.RSSI(i));
    Serial.print(" dBm  ch ");
    Serial.println(WiFi.channel(i));
  }
  WiFi.scanDelete();
}

void hardResetWifiRadio() {
  Serial.println("Hard-resetting WiFi radio…");
  WiFi.disconnect(true, false);
  delay(200);
  WiFi.mode(WIFI_OFF);
  delay(400);
  WiFi.mode(WIFI_STA);
  applyWifiRadioSettings();
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  delay(200);
}

void onWiFiConnected() {
  wifiWasConnected = true;
  wifiFailStreak = 0;
  wifiDisconnectFlag = false;
  applyWifiRadioSettings();
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  initTime();
  fetchCloudConfig();
  uploadSystemInfo();
  checkForOtaUpdate();
  lastOtaCheckMs = millis();
  lastWifiReconnectMs = millis();
}

void connectOrStartAP() {
  if (wifiSsid.length() == 0) {
    Serial.println("No WiFi saved -> starting AP");
    startConfigPortal();
    return;
  }

  if (connectToWiFi()) {
    portalMode = false;
    wifiWasConnected = true;
    applyWifiRadioSettings();
    WiFi.setAutoReconnect(true);
    WiFi.persistent(true);
  }
}

bool connectToWiFi() {
  if (wifiSsid.length() == 0) return false;

  WiFi.mode(WIFI_STA);
  applyWifiRadioSettings();
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);

  WiFi.disconnect(false, false);
  delay(250);

  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());

  Serial.print("Connecting to WiFi (");
  Serial.print(wifiSsid);
  Serial.println(") — will keep trying until connected");

  int tryCount = 0;
  int radioResets = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(WIFI_RETRY_WAIT_MS);
    Serial.print(".");
    tryCount++;
    yield();

    if (tryCount % 40 == 0) {
      Serial.println();
      Serial.print("Still connecting to ");
      Serial.print(wifiSsid);
      Serial.print(" (");
      Serial.print((tryCount * WIFI_RETRY_WAIT_MS) / 1000UL);
      Serial.println("s) — not giving up");
    }

    if (tryCount % WIFI_HARD_RESET_EVERY_TRIES == 0) {
      Serial.println();
      hardResetWifiRadio();
      radioResets++;
      applyWifiRadioSettings();
      WiFi.setAutoReconnect(true);
      WiFi.persistent(true);
      if (radioResets % WIFI_SCAN_EVERY_RESETS == 0) {
        logNearbyWifiNetworks();
      }
      WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
    }
  }
  Serial.println();

  Serial.print("Connected. IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("RSSI: ");
  Serial.print(WiFi.RSSI());
  Serial.println(" dBm");
  wifiWasConnected = true;
  wifiFailStreak = 0;
  wifiDisconnectFlag = false;
  return true;
}

/** If STA drops, block and retry forever while SSID is saved. Never open AP. */
bool ensureWiFiConnected() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasConnected || wifiDisconnectFlag) {
      Serial.println("WiFi back online");
      onWiFiConnected();
      logEvent("INFO", "WiFi reconnected");
    }
    wifiWasConnected = true;
    wifiDisconnectFlag = false;
    return true;
  }

  if (wifiSsid.length() == 0) {
    Serial.println("No WiFi credentials — cannot reconnect");
    return false;
  }

  Serial.println("WiFi disconnected — keeping retry until it comes back");
  wifiWasConnected = false;
  wifiDisconnectFlag = false;
  lastWifiReconnectMs = millis();

  if (connectToWiFi()) {
    onWiFiConnected();
    logEvent("INFO", "WiFi reconnected");
    return true;
  }
  return false;
}

void startConfigPortal() {
  portalMode = true;

  server.stop();
  delay(100);

  WiFi.disconnect(true, true);
  delay(300);

  WiFi.mode(WIFI_AP);
  applyWifiRadioSettings();
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
      "<label>Tank Height (cm)</label><br><input name='tank_height' value='160'><br><br>"
      "<label>Upload interval (seconds, Firebase overrides)</label><br><input name='interval_sec' value='1'><br><br>"
      "<label>Threshold (%)</label><br><input name='threshold' value='2'><br><br>"
      "<label>Min Valid Distance (cm)</label><br><input name='min_dist' value='20'><br><br>"
      "<label>OTA Check Interval (min)</label><br><input name='ota_int' value='5'><br><br>"
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
    if (server.arg("interval_sec").length()) sendIntervalSec = server.arg("interval_sec").toInt();
    else if (server.arg("interval").length()) sendIntervalSec = server.arg("interval").toInt();
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
    DynamicJsonDocument doc(512);
    doc["device_id"] = deviceId;
    doc["firmware"] = FW_VERSION;
    doc["tank_name"] = tankName;
    doc["level_percent"] = round(currentLevelPercent * 10.0) / 10.0;
    doc["water_height_cm"] = round(getWaterHeightCm(currentDistance) * 10.0) / 10.0;
    doc["distance_cm"] = round(currentDistance * 10.0) / 10.0;
    addQualityFields(doc.as<JsonObject>());
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
  char buf[16];
  snprintf(buf, sizeof(buf), "%02d-%02d-%02d-%03lu",
           timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec,
           millis() % 1000UL);
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

  DynamicJsonDocument doc(384);
  doc[key]["type"] = type;
  doc[key]["message"] = message;
  doc[key]["time"] = getISOTime();
  if (!isnan(currentTdsPpm) && currentTdsPpm >= 0.0f) {
    doc[key]["tds_ppm"] = round(currentTdsPpm * 10.0) / 10.0;
  }
  if (isValidTemperature(currentTempC)) {
    doc[key]["temperature_c"] = round(currentTempC * 10.0) / 10.0;
  }

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
  doc["interval_sec"] = sendIntervalSec;
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

void writeCloudConfig() {
  if (WiFi.status() != WL_CONNECTED) return;

  DynamicJsonDocument doc(512);
  doc["tank_height"] = tankHeightCm;
  doc["interval_sec"] = sendIntervalSec < 1 ? 1 : sendIntervalSec;
  doc["threshold"] = threshold;
  doc["min_valid_distance"] = minValidDistance;
  doc["tank_name"] = tankName;
  doc["ota_check_interval_min"] = otaCheckIntervalMin;
  doc["quality_enabled"] = true;
  doc["updated_at"] = getISOTime();

  String json;
  serializeJson(doc, json);
  if (firebasePut("devices/" + deviceId + "/config.json", json)) {
    Serial.println("Firebase config written");
  }
}

void fetchCloudConfig() {
  if (WiFi.status() != WL_CONNECTED) return;

  String response;
  if (!firebaseGet("devices/" + deviceId + "/config.json", response)) return;

  if (response == "null" || response.length() == 0) {
    sendIntervalSec = 1;
    writeCloudConfig();
    saveLocalPreferences();
    logEvent("INFO", "Default Firebase config created (interval_sec=1)");
    return;
  }

  DynamicJsonDocument doc(768);
  DeserializationError err = deserializeJson(doc, response);
  if (err) {
    logError("Cloud config parse failed");
    return;
  }

  if (!doc["tank_height"].isNull()) tankHeightCm = doc["tank_height"].as<float>();
  if (!doc["threshold"].isNull()) threshold = doc["threshold"].as<float>();
  if (!doc["min_valid_distance"].isNull()) minValidDistance = doc["min_valid_distance"].as<float>();
  if (!doc["tank_name"].isNull()) tankName = doc["tank_name"].as<String>();
  if (!doc["ota_check_interval_min"].isNull()) otaCheckIntervalMin = doc["ota_check_interval_min"].as<int>();

  if (!doc["interval_sec"].isNull()) {
    sendIntervalSec = doc["interval_sec"].as<int>();
  } else {
    sendIntervalSec = 1;
    doc["interval_sec"] = 1;
    doc["quality_enabled"] = true;
    String json;
    serializeJson(doc, json);
    firebasePut("devices/" + deviceId + "/config.json", json);
  }

  if (sendIntervalSec < 1) sendIntervalSec = 1;
  if (threshold < 0.1) threshold = 0.1;
  if (otaCheckIntervalMin < 1) otaCheckIntervalMin = 1;

  saveLocalPreferences();
  Serial.print("Cloud config: interval_sec=");
  Serial.print(sendIntervalSec);
  Serial.print(" tank_height=");
  Serial.println(tankHeightCm, 1);
  logEvent("INFO", "Cloud config loaded | interval_sec=" + String(sendIntervalSec));
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

bool isValidTemperature(float tempC) {
  return !isnan(tempC) && tempC > -55.0f && tempC < 125.0f;
}

float readTemperatureC() {
  tempSensor.requestTemperatures();
  float t = tempSensor.getTempCByIndex(0);
  if (!isValidTemperature(t)) return NAN;
  return t;
}

float readTdsPpm(float tempC) {
  long sum = 0;
  for (int i = 0; i < TDS_SAMPLES; i++) {
    sum += analogRead(TDS_PIN);
    delay(10);
  }

  float voltage = (sum / (float)TDS_SAMPLES) * TDS_VREF / TDS_ADC_MAX;
  float temp = isValidTemperature(tempC) ? tempC : 25.0f;
  float k = 1.0f + 0.02f * (temp - 25.0f);
  if (k < 0.5f) k = 0.5f;
  float v = voltage / k;
  float tds = (133.42f * v * v * v - 255.86f * v * v + 857.39f * v) * 0.5f;
  if (tds < 0) tds = 0;
  if (tds > TDS_MAX_PPM) tds = TDS_MAX_PPM;
  return tds;
}

void addQualityFields(JsonObject obj) {
  if (obj.isNull()) return;
  obj["tds_ppm"] = (!isnan(currentTdsPpm) && currentTdsPpm >= 0.0f)
      ? round(currentTdsPpm * 10.0) / 10.0
      : 0;
  if (isValidTemperature(currentTempC)) {
    obj["temperature_c"] = round(currentTempC * 10.0) / 10.0;
  } else {
    obj["temperature_c"] = nullptr;
  }
}

String formatQualityMessage() {
  String msg = "TDS ";
  msg += String(currentTdsPpm, 1);
  msg += " ppm";
  if (isValidTemperature(currentTempC)) {
    msg += " | Temp ";
    msg += String(currentTempC, 1);
    msg += " C";
  } else {
    msg += " | Temp n/a";
  }
  return msg;
}

bool shouldUpload(float levelPercent) {
  if (lastSentLevelPercent < -100.0) return true;
  return fabs(levelPercent - lastSentLevelPercent) >= threshold;
}

void uploadHistoricalData(float levelPercent, float distanceCm) {
  String dateKey = getDateKey();
  String timeKey = getTimeKey();
  String path = "devices/" + deviceId + "/history/" + dateKey + ".json";

  DynamicJsonDocument doc(384);
  JsonObject rec = doc.createNestedObject(timeKey);
  rec["level_percent"] = round(levelPercent * 10.0) / 10.0;
  rec["water_height_cm"] = round(getWaterHeightCm(distanceCm) * 10.0) / 10.0;
  rec["distance_cm"] = round(distanceCm * 10.0) / 10.0;
  addQualityFields(rec);
  rec["timestamp"] = getISOTime();

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

  DynamicJsonDocument doc(384);
  doc["level_percent"] = round(levelPercent * 10.0) / 10.0;
  doc["water_height_cm"] = round(getWaterHeightCm(distanceCm) * 10.0) / 10.0;
  doc["distance_cm"] = round(distanceCm * 10.0) / 10.0;
  addQualityFields(doc.as<JsonObject>());
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
  currentTempC = readTemperatureC();
  if (!isValidTemperature(currentTempC)) {
    logError("DS18B20 invalid reading");
  }

  currentTdsPpm = readTdsPpm(currentTempC);

  Serial.print("---- WATER QUALITY ---- ");
  Serial.println(formatQualityMessage());

  float distance = getStableDistance();

  if (distance < 0) {
    logEvent("INFO", "Ultrasonic invalid | " + formatQualityMessage());
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
  Serial.print("% | ");
  Serial.println(formatQualityMessage());

  //if (shouldUpload(currentLevelPercent)) {
  if(true){
    Serial.println("Upload condition met");
    uploadHistoricalData(currentLevelPercent, currentDistance);
    uploadLiveData(currentLevelPercent, currentDistance);

    lastSentLevelPercent = currentLevelPercent;
    prefs.putFloat("last_lvl", lastSentLevelPercent);

    logEvent("INFO", "Tank data uploaded | Level " + String(currentLevelPercent, 1) + "% | " + formatQualityMessage());
  } else {
    Serial.println("Upload skipped: no significant change");
    logEvent("INFO", "Upload skipped | " + formatQualityMessage());
  }
}

// ================= OTA =================
// Convert GitHub HTML/blob links into direct binary download URLs.
// Example:
//   https://github.com/user/repo/blob/main/Build/1.0.2/app.bin
// -> https://raw.githubusercontent.com/user/repo/main/Build/1.0.2/app.bin
String normalizeOtaUrl(String url) {
  url.trim();
  if (url.length() == 0) return url;

  // Drop trailing query/hash (e.g. ?raw=1) after rewrite if needed.
  int hashPos = url.indexOf('#');
  if (hashPos >= 0) url = url.substring(0, hashPos);

  if (url.indexOf("github.com/") >= 0) {
    if (url.indexOf("/blob/") >= 0) {
      url.replace("https://github.com/", "https://raw.githubusercontent.com/");
      url.replace("http://github.com/", "https://raw.githubusercontent.com/");
      url.replace("/blob/", "/");
    } else if (url.indexOf("/raw/") >= 0) {
      url.replace("https://github.com/", "https://raw.githubusercontent.com/");
      url.replace("http://github.com/", "https://raw.githubusercontent.com/");
      url.replace("/raw/", "/");
    }
  }

  // ?raw=1 is only for blob pages; strip after rewrite.
  int q = url.indexOf('?');
  if (q >= 0) url = url.substring(0, q);

  return url;
}

// Compare dotted versions like "1.0.2" vs "1.0.10". Returns true if candidate > current.
bool isNewerFirmware(const String &candidate, const String &current) {
  if (candidate.length() == 0) return false;
  if (current.length() == 0) return true;
  if (candidate == current) return false;

  int cMaj = 0, cMin = 0, cPat = 0;
  int uMaj = 0, uMin = 0, uPat = 0;
  sscanf(candidate.c_str(), "%d.%d.%d", &cMaj, &cMin, &cPat);
  sscanf(current.c_str(), "%d.%d.%d", &uMaj, &uMin, &uPat);

  if (cMaj != uMaj) return cMaj > uMaj;
  if (cMin != uMin) return cMin > uMin;
  if (cPat != uPat) return cPat > uPat;

  // Same numeric triple but different string (e.g. "1.0.1-rc") — treat as update.
  return candidate != current;
}

bool parseOtaManifest(const String &response, String &latestVersion, String &url, bool &enabled) {
  if (response.length() == 0 || response == "null") return false;

  DynamicJsonDocument doc(768);
  DeserializationError err = deserializeJson(doc, response);
  if (err) return false;

  latestVersion = doc["latest_version"] | doc["version"] | "";
  url = doc["url"] | doc["bin_url"] | doc["download_url"] | "";
  enabled = doc["enabled"] | true;
  latestVersion.trim();
  url.trim();
  return latestVersion.length() > 0 && url.length() > 0;
}

// Prefer the newer of device-level and global firmware manifests.
bool loadOtaManifest(String &latestVersion, String &url, bool &enabled) {
  String deviceResp;
  String globalResp;
  String dVer, dUrl, gVer, gUrl;
  bool dEn = false, gEn = false;
  bool haveDevice = false, haveGlobal = false;

  if (firebaseGet("devices/" + deviceId + "/firmware.json", deviceResp)) {
    haveDevice = parseOtaManifest(deviceResp, dVer, dUrl, dEn);
  }
  if (firebaseGet("firmware.json", globalResp)) {
    haveGlobal = parseOtaManifest(globalResp, gVer, gUrl, gEn);
  }

  if (!haveDevice && !haveGlobal) return false;

  if (haveDevice && haveGlobal) {
    // Pick the newer enabled manifest; if only one enabled, use that.
    if (dEn && gEn) {
      if (isNewerFirmware(gVer, dVer)) {
        latestVersion = gVer; url = gUrl; enabled = true;
      } else {
        latestVersion = dVer; url = dUrl; enabled = true;
      }
    } else if (dEn) {
      latestVersion = dVer; url = dUrl; enabled = true;
    } else if (gEn) {
      latestVersion = gVer; url = gUrl; enabled = true;
    } else {
      latestVersion = dVer; url = dUrl; enabled = false;
    }
    return true;
  }

  if (haveDevice) {
    latestVersion = dVer; url = dUrl; enabled = dEn;
    return true;
  }

  latestVersion = gVer; url = gUrl; enabled = gEn;
  return true;
}

void checkForOtaUpdate() {
  if (WiFi.status() != WL_CONNECTED) return;

  String latestVersion;
  String url;
  bool enabled = true;

  if (!loadOtaManifest(latestVersion, url, enabled)) {
    Serial.println("No OTA config found");
    return;
  }

  String downloadUrl = normalizeOtaUrl(url);

  Serial.println("---- OTA CHECK ----");
  Serial.print("Current FW: ");
  Serial.println(FW_VERSION);
  Serial.print("Latest FW: ");
  Serial.println(latestVersion);
  Serial.print("Enabled: ");
  Serial.println(enabled ? "true" : "false");
  Serial.print("URL (raw): ");
  Serial.println(url);
  Serial.print("URL (download): ");
  Serial.println(downloadUrl);

  if (!enabled) {
    Serial.println("OTA disabled in Firebase");
    return;
  }
  if (latestVersion.length() == 0 || downloadUrl.length() == 0) return;

  if (!isNewerFirmware(latestVersion, String(FW_VERSION))) {
    Serial.println("Already on latest firmware");
    return;
  }

  logEvent("INFO", "OTA update found: " + latestVersion);

  if (performHttpOta(downloadUrl)) {
    otaFailStreak = 0;
    logEvent("INFO", "OTA successful, rebooting");
    delay(1000);
    ESP.restart();
  } else {
    otaFailStreak++;
    lastOtaFailMs = millis();
    logError("OTA failed for " + latestVersion + " (attempt " + String(otaFailStreak) + ")");
  }
}

bool performHttpOta(const String &url) {
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(45);

  // GitHub / CDNs often 302; without this, OTA downloads HTML or fails.
  httpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  httpUpdate.rebootOnUpdate(false);
  httpUpdate.setLedPin(-1);

  Serial.print("OTA downloading: ");
  Serial.println(url);

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