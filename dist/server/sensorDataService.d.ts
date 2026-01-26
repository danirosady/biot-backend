export interface SensorDataInput {
    sensorId: string;
    rawData: Record<string, any>;
    quality?: 'GOOD' | 'POOR' | 'BAD';
    timestamp?: Date;
}
export interface SensorDataQuery {
    sensorId: string;
    startTime?: Date;
    endTime?: Date;
    limit?: number;
    includeThingsBoard?: boolean;
    aggregation?: {
        interval: number;
        function: 'MIN' | 'MAX' | 'AVG' | 'SUM' | 'COUNT';
    };
}
export declare class SensorDataService {
    storeSensorData(input: SensorDataInput, tenantId: string): Promise<{
        id: string;
        timestamp: Date;
        rawData: import("@prisma/client/runtime/library").JsonValue;
        formattedOutput: string | null;
        quality: string;
        sensorId: string;
    }>;
    getSensorData(query: SensorDataQuery, tenantId: string): Promise<{
        localData: any[];
        thingsBoardData: any[];
        sensor: {
            id: string;
            name: string;
            deviceId: string;
            deviceName: string;
            sensorType: {
                outputs: {
                    id: string;
                    name: string;
                    createdAt: Date;
                    updatedAt: Date;
                    sensorTypeId: string;
                    unit: string;
                    dataType: string;
                    minValue: number | null;
                    maxValue: number | null;
                }[];
            } & {
                id: string;
                name: string;
                createdAt: Date;
                updatedAt: Date;
                description: string | null;
                category: string;
                requiredPins: import("@prisma/client/runtime/library").JsonValue;
            };
        };
    }>;
    deleteSensorData(sensorId: string, tenantId: string, options?: {
        startTime?: Date;
        endTime?: Date;
        deleteFromThingsBoard?: boolean;
    }): Promise<void>;
    private transformThingsBoardData;
    getSensorDataStats(sensorId: string, tenantId: string, timeRange: {
        startTime: Date;
        endTime: Date;
    }): Promise<{
        totalRecords: number;
        firstRecord: Date | null;
        lastRecord: Date | null;
        timeRange: {
            startTime: Date;
            endTime: Date;
        };
    }>;
}
export declare const sensorDataService: SensorDataService;
//# sourceMappingURL=sensorDataService.d.ts.map