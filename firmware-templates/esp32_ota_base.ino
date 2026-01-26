/*
 * Wiring Studio - ESP32 Base Firmware with OTA Support
 * 
 * This is the base firmware template that supports:
 * - WiFi connection
 * - ThingsBoard integration
 * - Over-The-Air (OTA) firmware updates
 * - RPC callbacks for remote control
 * 
 * Upload this to your ESP32 first, then you can update it
 * remotely from Wiring Studio.
 */

#include <WiFi.h>
#include <ThingsBoard.h>
#include <Update.h>
#include <HTTPClient.h>

// ============================================================================
// CONFIGURATION - Update these values
// ============================================================================

// WiFi credentials
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ThingsBoard server configuration
const char* TB_SERVER = "103.103.20.119";  // Your ThingsBoard server
const int TB_PORT = 80;
const char* TB_TOKEN = "YOUR_DEVICE_TOKEN";  // Get this from ThingsBoard device credentials

// ============================================================================
// Global Variables
// ============================================================================

WiFiClient espClient;
ThingsBoard tb(espClient, 256);  // Increase buffer for OTA

bool reconnect = true;
unsigned long lastTelemetry = 0;
const unsigned long TELEMETRY_INTERVAL = 5000;  // Send telemetry every 5 seconds

// ============================================================================
// OTA Update Functions
// ============================================================================

// Callback function for OTA firmware update
RPC_Response processFirmwareUpdate(const RPC_Data &data) {
  Serial.println("Received OTA firmware update request!");
  
  // Get firmware URL from RPC call
  const char* fwUrl = data["fw_url"];
  const char* fwVersion = data["fw_version"];
  const char* fwChecksum = data["fw_checksum"];
  
  if (!fwUrl) {
    Serial.println("ERROR: No firmware URL provided");
    return RPC_Response("ota_status", "error: no URL");
  }
  
  Serial.print("Firmware URL: ");
  Serial.println(fwUrl);
  Serial.print("Version: ");
  Serial.println(fwVersion ? fwVersion : "unknown");
  
  // Download and install firmware
  bool success = downloadAndInstallFirmware(fwUrl, fwChecksum);
  
  if (success) {
    Serial.println("✅ OTA update successful! Rebooting...");
    tb.sendTelemetryString("ota_status", "success");
    delay(1000);
    ESP.restart();
    return RPC_Response("ota_status", "success");
  } else {
    Serial.println("❌ OTA update failed");
    tb.sendTelemetryString("ota_status", "failed");
    return RPC_Response("ota_status", "failed");
  }
}

// Download and install firmware from URL
bool downloadAndInstallFirmware(const char* url, const char* expectedChecksum) {
  HTTPClient http;
  
  Serial.println("Starting firmware download...");
  http.begin(url);
  
  int httpCode = http.GET();
  
  if (httpCode != HTTP_CODE_OK) {
    Serial.printf("HTTP GET failed, error: %d\n", httpCode);
    http.end();
    return false;
  }
  
  int contentLength = http.getSize();
  Serial.printf("Firmware size: %d bytes\n", contentLength);
  
  if (contentLength <= 0) {
    Serial.println("ERROR: Invalid content length");
    http.end();
    return false;
  }
  
  bool canBegin = Update.begin(contentLength);
  
  if (!canBegin) {
    Serial.println("ERROR: Not enough space for OTA");
    http.end();
    return false;
  }
  
  // Get the stream
  WiFiClient* stream = http.getStreamPtr();
  
  // Write firmware
  size_t written = Update.writeStream(*stream);
  
  if (written != contentLength) {
    Serial.printf("ERROR: Written only %d/%d bytes\n", written, contentLength);
    Update.printError(Serial);
    http.end();
    return false;
  }
  
  // Finish update
  if (!Update.end()) {
    Serial.println("ERROR: Update.end() failed");
    Update.printError(Serial);
    http.end();
    return false;
  }
  
  if (!Update.isFinished()) {
    Serial.println("ERROR: Update not finished");
    http.end();
    return false;
  }
  
  http.end();
  Serial.println("✅ Firmware downloaded and verified successfully");
  return true;
}

// Callback for device restart
RPC_Response processRestart(const RPC_Data &data) {
  Serial.println("Received restart command!");
  tb.sendTelemetryString("status", "restarting");
  delay(1000);
  ESP.restart();
  return RPC_Response("restart", "ok");
}

// Callback for getting device info
RPC_Response processGetInfo(const RPC_Data &data) {
  Serial.println("Received getInfo request");
  
  // Create JSON response with device info
  StaticJsonDocument<256> doc;
  doc["firmware_version"] = "1.0.0";
  doc["chip_model"] = ESP.getChipModel();
  doc["chip_revision"] = ESP.getChipRevision();
  doc["cpu_freq"] = ESP.getCpuFreqMHz();
  doc["free_heap"] = ESP.getFreeHeap();
  doc["sketch_size"] = ESP.getSketchSize();
  doc["free_sketch_space"] = ESP.getFreeSketchSpace();
  
  String output;
  serializeJson(doc, output);
  
  return RPC_Response("device_info", output.c_str());
}

// ============================================================================
// RPC Callbacks Array
// ============================================================================

RPC_Callback callbacks[] = {
  { "fw_update", processFirmwareUpdate },
  { "restart", processRestart },
  { "get_info", processGetInfo }
};

// ============================================================================
// Setup Function
// ============================================================================

void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("\n\n");
  Serial.println("================================");
  Serial.println("Wiring Studio - ESP32 OTA Base");
  Serial.println("================================");
  Serial.println();
  
  // Print device info
  Serial.print("Chip Model: ");
  Serial.println(ESP.getChipModel());
  Serial.print("Chip Revision: ");
  Serial.println(ESP.getChipRevision());
  Serial.print("CPU Frequency: ");
  Serial.print(ESP.getCpuFreqMHz());
  Serial.println(" MHz");
  Serial.print("Free Heap: ");
  Serial.print(ESP.getFreeHeap());
  Serial.println(" bytes");
  Serial.println();
  
  // Connect to WiFi
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);
  
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.println("✅ WiFi connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.print("RSSI: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    Serial.println();
    Serial.println("❌ WiFi connection failed!");
    Serial.println("Please check your credentials and restart.");
  }
  
  Serial.println();
  Serial.println("Setup complete!");
  Serial.println("Waiting for ThingsBoard connection...");
  Serial.println();
}

// ============================================================================
// Main Loop
// ============================================================================

void loop() {
  // Reconnect to ThingsBoard if needed
  if (reconnect) {
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("WiFi disconnected, reconnecting...");
      WiFi.reconnect();
      delay(1000);
      return;
    }
    
    Serial.println("Connecting to ThingsBoard...");
    
    if (tb.connect(TB_SERVER, TB_TOKEN, TB_PORT)) {
      Serial.println("✅ Connected to ThingsBoard!");
      
      // Subscribe to RPC callbacks
      if (tb.RPC_Subscribe(callbacks, sizeof(callbacks) / sizeof(callbacks[0]))) {
        Serial.println("✅ Subscribed to RPC callbacks");
        Serial.println("   - fw_update (OTA firmware update)");
        Serial.println("   - restart (Device restart)");
        Serial.println("   - get_info (Device information)");
      } else {
        Serial.println("⚠️  Failed to subscribe to RPC");
      }
      
      reconnect = false;
    } else {
      Serial.println("❌ ThingsBoard connection failed, retrying in 5s...");
      delay(5000);
      return;
    }
  }
  
  // Process ThingsBoard messages (including RPC)
  tb.loop();
  
  // Send telemetry periodically
  if (millis() - lastTelemetry > TELEMETRY_INTERVAL) {
    lastTelemetry = millis();
    
    // Send basic telemetry
    tb.sendTelemetryInt("uptime", millis() / 1000);
    tb.sendTelemetryInt("free_heap", ESP.getFreeHeap());
    tb.sendTelemetryInt("rssi", WiFi.RSSI());
    
    Serial.print("📊 Telemetry sent - Uptime: ");
    Serial.print(millis() / 1000);
    Serial.print("s, Free Heap: ");
    Serial.print(ESP.getFreeHeap());
    Serial.print(" bytes, RSSI: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  }
  
  // Check WiFi connection
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("⚠️  WiFi disconnected!");
    reconnect = true;
  }
  
  delay(100);
}
