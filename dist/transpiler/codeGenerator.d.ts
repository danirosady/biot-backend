export interface CanvasNode {
    id: string;
    type: string;
    position: {
        x: number;
        y: number;
    };
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
    sourceHandle?: string;
    targetHandle?: string;
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
export declare function generateArduinoCode(nodes: CanvasNode[], edges: CanvasEdge[], config?: CodeGenerationConfig): {
    code: string;
    validation: ValidationResult;
    libraries: string[];
};
/**
 * Helper to extract WiFi and ThingsBoard config from device
 */
export declare function extractDeviceConfig(deviceInfo: any): CodeGenerationConfig;
//# sourceMappingURL=codeGenerator.d.ts.map