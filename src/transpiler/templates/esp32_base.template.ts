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
    loopDelay
  } = data;

  return `/*
 * Wiring Studio - Auto-generated ESP32 Firmware
 * Generated: ${new Date().toISOString()}
 * 
 * This firmware integrates with ThingsBoard for IoT device management
 * and OTA updates.
 */

#include <WiFi.h>
#include <ThingsBoard.h>
${includes.join('\n')}

// WiFi credentials
const char* WIFI_SSID = "${wifiSSID}";
const char* WIFI_PASSWORD = "${wifiPassword}";

// ThingsBoard server configuration
const char* TB_SERVER = "${tbServer}";
const char* TB_TOKEN = "${tbToken}";

// Initialize WiFi and ThingsBoard clients
WiFiClient espClient;
ThingsBoard tb(espClient);

// Sensor initializations
${sensorInits.join('\n')}

// Connection status
bool reconnect = true;
unsigned long lastSend = 0;

void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("Wiring Studio - ESP32 Firmware");
  Serial.println("Connecting to WiFi...");
  
  // Connect to WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  Serial.println();
  Serial.print("Connected! IP address: ");
  Serial.println(WiFi.localIP());
  
  // Initialize sensors
${sensorSetups.join('\n')}
  
  Serial.println("Setup complete!");
}

void loop() {
  // Maintain ThingsBoard connection
  if (reconnect) {
    Serial.println("Connecting to ThingsBoard...");
    if (tb.connect(TB_SERVER, TB_TOKEN)) {
      Serial.println("Connected to ThingsBoard!");
      reconnect = false;
    } else {
      Serial.println("Failed to connect to ThingsBoard");
      delay(5000);
      return;
    }
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
    reconnect = true;
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
    `    tb.sendTelemetryFloat("${key}", ${key});`
  ).join('\n');
  
  return `// Prepare telemetry data\n${sendStatements}`;
}
