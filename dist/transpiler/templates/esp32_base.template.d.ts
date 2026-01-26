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
export declare function generateESP32Code(data: TemplateData): string;
//# sourceMappingURL=esp32_base.template.d.ts.map