// Base ESP32 firmware template with ThingsBoard integration
export interface TemplateData {
  includes: string[];
  sensorInits: string[];
  sensorSetups: string[];
  sensorLoops: string[];
  telemetryKeys: string[];
  wifiSSID: string;
  wifiPassword: string;
  tbServer: string;
  tbToken: string;
  loopDelay: number;
  firmwareTitle?: string;
  firmwareVersion?: string;
}

export function generateESP32Code(data: TemplateData): string {
  const {
    includes,
    sensorInits,
    sensorSetups,
    sensorLoops,
    telemetryKeys,
    wifiSSID,
    wifiPassword,
    tbServer,
    tbToken,
    loopDelay,
    firmwareTitle,
    firmwareVersion
  } = data;

  return `/*
 * Wiring Studio - Auto-generated ESP32 Firmware
 * Generated: ${new Date().toISOString()}
 * 
 * This firmware integrates with ThingsBoard for IoT device management
 * and OTA updates.
 */

#include <WiFi.h>
#include <array>
#include <Arduino_MQTT_Client.h>
#include <OTA_Firmware_Update.h>
#include <Espressif_Updater.h>
#include <ThingsBoard.h>
${includes.join('\n')}

// WiFi credentials
const char* WIFI_SSID = "${wifiSSID}";
const char* WIFI_PASSWORD = "${wifiPassword}";

// ThingsBoard server configuration
const char* TB_SERVER = "${tbServer}";
const char* TB_TOKEN = "${tbToken}";
constexpr uint16_t THINGSBOARD_PORT = 1883U;

// OTA metadata
constexpr char CURRENT_FIRMWARE_TITLE[] = "${firmwareTitle || 'WIRING_STUDIO'}";
constexpr char CURRENT_FIRMWARE_VERSION[] = "${firmwareVersion || '1.0.0'}";
constexpr uint8_t FIRMWARE_FAILURE_RETRIES = 12U;
constexpr uint16_t FIRMWARE_PACKET_SIZE = 16384U;

// Initialize WiFi and ThingsBoard clients
WiFiClient espClient;
Arduino_MQTT_Client mqttClient(espClient);
constexpr uint16_t MAX_MESSAGE_RECEIVE_SIZE = 512U;
constexpr uint16_t MAX_MESSAGE_SEND_SIZE = 512U;
OTA_Firmware_Update<> ota;
const std::array<IAPI_Implementation*, 1U> apis = { &ota };
ThingsBoard tb(mqttClient, MAX_MESSAGE_RECEIVE_SIZE, MAX_MESSAGE_SEND_SIZE, Default_Max_Stack_Size, apis);
Espressif_Updater<> updater;

// Sensor initializations
${sensorInits.join('\n')}

// Connection status
bool reconnectToTb = true;
unsigned long lastSend = 0;
bool currentFWSent = false;
bool updateRequestSent = false;

void initWiFi() {
  Serial.println("Connecting to AP ...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("Connected to AP");
}

bool reconnectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }
  initWiFi();
  return true;
}

void updateStartingCallback() {
  Serial.println("[OTA] Update starting");
}

void finishedCallback(const bool & success) {
  if (success) {
    Serial.println("[OTA] Update completed. Rebooting...");
    esp_restart();
    return;
  }
  Serial.println("[OTA] Firmware download failed");
}

void progressCallback(const size_t & current, const size_t & total) {
  Serial.printf("[OTA] Progress %.2f%%\\n", static_cast<float>(current * 100U) / total);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("Wiring Studio - ESP32 Firmware");
  Serial.printf("Firmware: %s v%s\\n", CURRENT_FIRMWARE_TITLE, CURRENT_FIRMWARE_VERSION);
  
  initWiFi();
  
  // Initialize sensors
${sensorSetups.join('\n')}
  
  Serial.println("Setup complete!");
}

void loop() {
  if (!reconnectWiFi()) {
    return;
  }

  // Maintain ThingsBoard connection
  if (reconnectToTb || !tb.connected()) {
    Serial.println("Connecting to ThingsBoard...");
    if (tb.connect(TB_SERVER, TB_TOKEN, THINGSBOARD_PORT)) {
      Serial.println("Connected to ThingsBoard!");
      reconnectToTb = false;
    } else {
      Serial.println("Failed to connect to ThingsBoard");
      delay(5000);
      return;
    }
  }

  if (!currentFWSent) {
    currentFWSent = ota.Firmware_Send_Info(CURRENT_FIRMWARE_TITLE, CURRENT_FIRMWARE_VERSION);
  }

  if (!updateRequestSent) {
    const OTA_Update_Callback callback(
      CURRENT_FIRMWARE_TITLE,
      CURRENT_FIRMWARE_VERSION,
      &updater,
      &finishedCallback,
      &progressCallback,
      &updateStartingCallback,
      FIRMWARE_FAILURE_RETRIES,
      FIRMWARE_PACKET_SIZE
    );
    updateRequestSent = ota.Start_Firmware_Update(callback);
  }
  
  // Process ThingsBoard messages
  tb.loop();
  
  // Send telemetry at intervals
  if (millis() - lastSend > ${loopDelay}) {
    lastSend = millis();
    
    Serial.println("\\n--- Reading Sensors ---");
${sensorLoops.join('\n')}
    
    // Send telemetry to ThingsBoard
    ${generateTelemetrySend(telemetryKeys)}
    
    Serial.println("Telemetry sent!");
  }
  
  // Check WiFi connection
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected, reconnecting...");
    WiFi.reconnect();
    reconnectToTb = true;
  }
  
  // Small delay to prevent watchdog issues
  delay(100);
}
`;
}

function generateTelemetrySend(keys: string[]): string {
  if (keys.length === 0) {
    return '// No telemetry keys defined';
  }
  
  const sendStatements = keys.map(key => 
    `    tb.sendTelemetryData("${key}", ${key});`
  ).join('\n');
  
  return `// Prepare telemetry data\n${sendStatements}`;
}
