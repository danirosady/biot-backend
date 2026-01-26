export interface BuildConfig {
    code: string;
    boardType: string;
    libraries?: string[];
}
export interface BuildResult {
    success: boolean;
    binPath?: string;
    logs: string[];
    error?: string;
}
/**
 * Arduino CLI wrapper for compiling firmware
 */
export declare class ArduinoBuilder {
    private arduinoCliPath;
    private workDir;
    constructor(arduinoCliPath?: string);
    /**
     * Compile Arduino code to .bin file
     */
    compile(config: BuildConfig): Promise<BuildResult>;
    /**
     * Install Arduino library
     */
    private installLibrary;
    /**
     * Extract library names from #include statements
     */
    private extractLibraries;
    /**
     * Find the compiled .bin file
     */
    private findBinFile;
    /**
     * Create temporary work directory
     */
    private createWorkDir;
    /**
     * Clean up work directory
     */
    cleanup(): Promise<void>;
    /**
     * Copy compiled binary to permanent storage
     */
    copyToStorage(binPath: string, targetDir: string, filename: string): Promise<string>;
    /**
     * Check if Arduino CLI is available
     */
    checkArduinoCli(): Promise<boolean>;
    /**
     * Install ESP32 board support if needed
     */
    installEsp32Board(): Promise<void>;
}
//# sourceMappingURL=arduinoBuilder.d.ts.map