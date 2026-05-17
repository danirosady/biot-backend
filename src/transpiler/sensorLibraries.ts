// Sensor library configurations for code generation
export interface SensorConfig {
  library: string;
  arduinoLibName: string; // For arduino-cli lib install
  includeStatement: string;
  initCode: (varName: string, pinMapping: Record<string, string>) => string;
  setupCode: (varName: string) => string;
  loopCode: (varName: string) => string;
  telemetryKeys: string[];
  pinRequirements: string[];
}

export const SENSOR_LIBRARIES: Record<string, SensorConfig> = {
  DHT11: {
    library: 'DHT sensor library',
    arduinoLibName: 'DHT sensor library',
    includeStatement: '#include <DHT.h>',
    pinRequirements: ['VCC', 'GND', 'DATA'],
    telemetryKeys: ['temperature', 'humidity'],
    initCode: (varName, pinMapping) => {
      const dataPin = pinMapping.DATA?.replace('D', '') || '4';
      return `DHT dht(${dataPin}, DHT11);\nDHT &dht111 = dht;`;
    },
    setupCode: (varName) => `  ${varName}.begin();`,
    loopCode: (varName) => `
  // Read DHT11 sensor
  float temperature = ${varName}.readTemperature();
  float humidity = ${varName}.readHumidity();
  
  if (!isnan(temperature) && !isnan(humidity)) {
    Serial.print("Temperature: ");
    Serial.print(temperature);
    Serial.print("°C, Humidity: ");
    Serial.print(humidity);
    Serial.println("%");
  }`,
  },

  'HC-SR04': {
    library: 'Ultrasonic',
    arduinoLibName: 'Ultrasonic',
    includeStatement: '#include <Ultrasonic.h>',
    pinRequirements: ['VCC', 'GND', 'TRIG', 'ECHO'],
    telemetryKeys: ['distance'],
    initCode: (varName, pinMapping) => {
      const trigPin = pinMapping.TRIG?.replace('D', '') || '5';
      const echoPin = pinMapping.ECHO?.replace('D', '') || '18';
      return `Ultrasonic ${varName}(${trigPin}, ${echoPin});`;
    },
    setupCode: () => '',
    loopCode: (varName) => `
  // Read HC-SR04 sensor
  float distance = ${varName}.read();
  
  if (distance > 0) {
    Serial.print("Distance: ");
    Serial.print(distance);
    Serial.println(" cm");
  }`,
  },

  DS18B20: {
    library: 'DallasTemperature',
    arduinoLibName: 'DallasTemperature',
    includeStatement: '#include <OneWire.h>\n#include <DallasTemperature.h>',
    pinRequirements: ['VCC', 'GND', 'DATA'],
    telemetryKeys: ['temperature'],
    initCode: (varName, pinMapping) => {
      const dataPin = pinMapping.DATA?.replace('D', '') || '4';
      const oneWireVar = `${varName}OneWire`;
      return `OneWire ${oneWireVar}(${dataPin});\nDallasTemperature ${varName}(&${oneWireVar});`;
    },
    setupCode: (varName) => `  ${varName}.begin();`,
    loopCode: (varName) => `
  // Read DS18B20 sensor
  ${varName}.requestTemperatures();
  float temperature = ${varName}.getTempCByIndex(0);
  
  if (temperature != DEVICE_DISCONNECTED_C) {
    Serial.print("Temperature: ");
    Serial.print(temperature);
    Serial.println("°C");
  }`,
  },

  'Soil Moisture': {
    library: 'AnalogRead',
    arduinoLibName: '', // Built-in, no library needed
    includeStatement: '',
    pinRequirements: ['VCC', 'GND', 'AOUT'],
    telemetryKeys: ['moisture'],
    initCode: (varName, pinMapping) => {
      const analogPin = pinMapping.AOUT?.replace('A', '') || '0';
      const pinVar = `${varName.toUpperCase()}_PIN`;
      return `const int ${pinVar} = A${analogPin};`;
    },
    setupCode: (varName) => {
      const pinVar = `${varName.toUpperCase()}_PIN`;
      return `  pinMode(${pinVar}, INPUT);`;
    },
    loopCode: (varName) => {
      const pinVar = `${varName.toUpperCase()}_PIN`;
      return `
  // Read Soil Moisture sensor
  int soilValue = analogRead(${pinVar});
  float moisture = map(soilValue, 0, 4095, 0, 100); // Convert to percentage
  
  Serial.print("Soil Moisture: ");
  Serial.print(moisture);
  Serial.println("%");`;
    },
  },
};

// Extract all required libraries for arduino-cli installation
export function getRequiredLibraries(sensorTypes: string[]): string[] {
  const libraries = new Set<string>();
  
  for (const sensorType of sensorTypes) {
    const config = SENSOR_LIBRARIES[sensorType];
    if (config && config.arduinoLibName) {
      libraries.add(config.arduinoLibName);
    }
  }
  
  return Array.from(libraries);
}

// Get all telemetry keys from sensors
export function getAllTelemetryKeys(sensorTypes: string[]): string[] {
  const keys = new Set<string>();
  
  for (const sensorType of sensorTypes) {
    const config = SENSOR_LIBRARIES[sensorType];
    if (config) {
      config.telemetryKeys.forEach(key => keys.add(key));
    }
  }
  
  return Array.from(keys);
}
