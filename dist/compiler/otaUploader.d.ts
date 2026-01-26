export interface OtaConfig {
    binPath: string;
    deviceId: string;
    version: string;
    title?: string;
    description?: string;
    tbServer: string;
    tbToken: string;
}
export interface OtaResult {
    success: boolean;
    packageId?: string;
    error?: string;
}
/**
 * ThingsBoard OTA firmware uploader
 */
export declare class OtaUploader {
    private tbBaseUrl;
    constructor(tbBaseUrl?: string);
    /**
     * Upload firmware to ThingsBoard and trigger OTA update
     */
    uploadAndDeploy(config: OtaConfig): Promise<OtaResult>;
    /**
     * Get device information
     */
    private getDeviceInfo;
    /**
     * Assign firmware package to device
     */
    private assignFirmwareToDevice;
    /**
     * Get OTA package info
     */
    getPackageInfo(packageId: string, token: string): Promise<any>;
    /**
     * List OTA packages for device profile
     */
    listPackages(deviceProfileId: string, token: string): Promise<any[]>;
    /**
     * Delete OTA package
     */
    deletePackage(packageId: string, token: string): Promise<void>;
}
//# sourceMappingURL=otaUploader.d.ts.map