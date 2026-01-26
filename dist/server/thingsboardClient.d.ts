export declare function listDevices(page?: number, pageSize?: number, type?: string): Promise<{
    data: Array<any>;
    totalPages: number;
    totalElements: number;
    hasNext: boolean;
}>;
export declare function getDeviceInfo(deviceId: string): Promise<any>;
export declare function getAttributes(deviceId: string, scope: "SERVER_SCOPE" | "SHARED_SCOPE" | "CLIENT_SCOPE"): Promise<any[]>;
export declare function getLatestTelemetry(deviceId: string, keys?: string): Promise<Record<string, {
    ts: number;
    value: any;
}[]>>;
export declare function sendTelemetry(deviceId: string, telemetryData: Record<string, any>): Promise<any>;
export declare function getTelemetryHistory(deviceId: string, keys: string[], startTs: number, endTs: number, interval?: number, limit?: number): Promise<Record<string, {
    ts: number;
    value: any;
}[]>>;
export declare function getAggregatedTelemetry(deviceId: string, keys: string[], startTs: number, endTs: number, interval: number, agg: 'MIN' | 'MAX' | 'AVG' | 'SUM' | 'COUNT'): Promise<Record<string, {
    ts: number;
    value: any;
}[]>>;
export declare function deleteDeviceTelemetry(deviceId: string, keys: string[], deleteAllDataForKeys?: boolean): Promise<any>;
//# sourceMappingURL=thingsboardClient.d.ts.map