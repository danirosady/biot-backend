export interface SensorConfig {
    library: string;
    arduinoLibName: string;
    includeStatement: string;
    initCode: (pinMapping: Record<string, string>) => string;
    setupCode: (varName: string) => string;
    loopCode: (varName: string) => string;
    telemetryKeys: string[];
    pinRequirements: string[];
}
export declare const SENSOR_LIBRARIES: Record<string, SensorConfig>;
export declare function getRequiredLibraries(sensorTypes: string[]): string[];
export declare function getAllTelemetryKeys(sensorTypes: string[]): string[];
//# sourceMappingURL=sensorLibraries.d.ts.map