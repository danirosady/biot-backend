export interface TemplateData {
    [key: string]: any;
    timestamp?: string;
    date?: string;
    time?: string;
    deviceName?: string;
    sensorName?: string;
}
export declare function processTemplate(template: string, data: TemplateData): string;
export declare function validateTemplate(template: string, availableVariables: string[]): {
    isValid: boolean;
    errors: string[];
};
//# sourceMappingURL=templateProcessor.d.ts.map