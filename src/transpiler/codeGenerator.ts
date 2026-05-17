import { SENSOR_LIBRARIES, getRequiredLibraries, getAllTelemetryKeys } from './sensorLibraries';
import { generateESP32Code, TemplateData } from './templates/esp32_base.template';

// Types matching the frontend canvas
export interface CanvasNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    type: 'esp32' | 'sensor' | 'chart';
    sensorType?: string;
    boardType?: string;
    deviceId?: string;
    pinMapping?: Record<string, string>;
  };
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string; // GPIO pin from ESP32
  targetHandle?: string; // Pin on sensor
}

export interface CodeGenerationConfig {
  wifiSSID?: string;
  wifiPassword?: string;
  tbServer?: string;
  tbToken?: string;
  loopDelay?: number;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Main code generator function
 * Converts React Flow canvas to Arduino C++ code
 */
export function generateArduinoCode(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  config: CodeGenerationConfig = {}
): { code: string; validation: ValidationResult; libraries: string[] } {
  // Validate the graph
  const validation = validateGraph(nodes, edges);
  if (!validation.isValid) {
    throw new Error(`Invalid graph: ${validation.errors.join(', ')}`);
  }

  // Find ESP32 node
  const esp32Node = nodes.find(n => n.data.type === 'esp32');
  if (!esp32Node) {
    throw new Error('No ESP32 node found');
  }

  // Find all sensor nodes
  const sensorNodes = nodes.filter(n => n.data.type === 'sensor');

  // Build pin mappings from edges
  const pinMappings = buildPinMappings(edges, nodes);

  // Generate code sections
  const includes: string[] = [];
  const sensorInits: string[] = [];
  const sensorSetups: string[] = [];
  const sensorLoops: string[] = [];
  const sensorTypes: string[] = [];

  sensorNodes.forEach((sensorNode, index) => {
    const sensorType = sensorNode.data.sensorType || 'DHT11';
    const sensorConfig = SENSOR_LIBRARIES[sensorType];

    if (!sensorConfig) {
      console.warn(`Unknown sensor type: ${sensorType}`);
      return;
    }

    sensorTypes.push(sensorType);

    // Add include statement
    if (sensorConfig.includeStatement) {
      includes.push(sensorConfig.includeStatement);
    }

    // Get pin mapping for this sensor
    const sensorPinMapping = pinMappings[sensorNode.id] || {};

    // Generate variable name
    const varName = sensorType === 'DHT11'
      ? 'dht'
      : sensorType.toLowerCase().replace(/[^a-z0-9]/g, '') + (index + 1);

    // Add initialization code
    const initCode = sensorConfig.initCode(varName, sensorPinMapping);
    sensorInits.push(`// ${sensorNode.data.label || sensorType}\n${initCode}`);

    // Add setup code
    const setupCode = sensorConfig.setupCode(varName);
    if (setupCode.trim()) {
      sensorSetups.push(`  // Setup ${sensorNode.data.label || sensorType}\n${setupCode}`);
    }

    // Add loop code (replace varName placeholder)
    const loopCode = sensorConfig.loopCode(varName);
    sensorLoops.push(`    // Read ${sensorNode.data.label || sensorType}\n${loopCode}`);
  });

  // Get all telemetry keys
  const telemetryKeys = getAllTelemetryKeys(sensorTypes);

  // Build template data
  const templateData: TemplateData = {
    includes,
    sensorInits,
    sensorSetups,
    sensorLoops,
    telemetryKeys,
    wifiSSID: config.wifiSSID || 'YOUR_WIFI_SSID',
    wifiPassword: config.wifiPassword || 'YOUR_WIFI_PASSWORD',
    tbServer: config.tbServer || '103.103.20.119',
    tbToken: config.tbToken || 'YOUR_DEVICE_TOKEN',
    loopDelay: config.loopDelay || 5000,
  };

  // Generate final code
  const code = generateESP32Code(templateData);

  // Get required libraries
  const libraries = getRequiredLibraries(sensorTypes);

  return {
    code,
    validation,
    libraries,
  };
}

/**
 * Validate the canvas graph
 */
function validateGraph(nodes: CanvasNode[], edges: CanvasEdge[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for ESP32 node
  const esp32Nodes = nodes.filter(n => n.data.type === 'esp32');
  if (esp32Nodes.length === 0) {
    errors.push('At least one ESP32 node is required');
  }
  if (esp32Nodes.length > 1) {
    warnings.push('Multiple ESP32 nodes found, only the first will be used');
  }

  // Check for sensor nodes
  const sensorNodes = nodes.filter(n => n.data.type === 'sensor');
  if (sensorNodes.length === 0) {
    warnings.push('No sensor nodes found');
  }

  // Check if all sensors are connected
  sensorNodes.forEach(sensor => {
    const connectedEdges = edges.filter(
      e => e.source === sensor.id || e.target === sensor.id
    );
    if (connectedEdges.length === 0) {
      warnings.push(`Sensor "${sensor.data.label || 'Unnamed'}" is not connected`);
    }
  });

  // Check for duplicate GPIO pin usage
  const gpioUsage = new Map<string, string[]>();
  edges.forEach(edge => {
    if (edge.sourceHandle) {
      const users = gpioUsage.get(edge.sourceHandle) || [];
      users.push(edge.target);
      gpioUsage.set(edge.sourceHandle, users);
    }
  });

  gpioUsage.forEach((users, pin) => {
    if (users.length > 1) {
      errors.push(`GPIO pin ${pin} is connected to multiple sensors`);
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Build pin mappings from edges
 */
function buildPinMappings(
  edges: CanvasEdge[],
  nodes: CanvasNode[]
): Record<string, Record<string, string>> {
  const pinMappings: Record<string, Record<string, string>> = {};

  edges.forEach(edge => {
    const targetNode = nodes.find(n => n.id === edge.target);
    if (!targetNode || targetNode.data.type !== 'sensor') {
      return;
    }

    if (!pinMappings[edge.target]) {
      pinMappings[edge.target] = {};
    }

    // Map: sensor pin name -> ESP32 GPIO pin
    if (edge.targetHandle && edge.sourceHandle) {
      pinMappings[edge.target][edge.targetHandle] = edge.sourceHandle;
    }
  });

  return pinMappings;
}

/**
 * Helper to extract WiFi and ThingsBoard config from device
 */
export function extractDeviceConfig(deviceInfo: any): CodeGenerationConfig {
  // This would typically pull from ThingsBoard device attributes
  return {
    wifiSSID: deviceInfo?.wifiSSID || process.env.DEFAULT_WIFI_SSID,
    wifiPassword: deviceInfo?.wifiPassword || process.env.DEFAULT_WIFI_PASSWORD,
    tbServer: deviceInfo?.tbServer || process.env.THINGSBOARD_BASE_URL?.replace('http://', ''),
    tbToken: deviceInfo?.accessToken || 'DEVICE_TOKEN_HERE',
    loopDelay: deviceInfo?.telemetryInterval || 5000,
  };
}
