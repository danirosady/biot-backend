import { Queue } from 'bullmq';
export interface CompileJobData {
    jobId: string;
    code: string;
    boardType: string;
    deviceId: string;
    version: string;
    tbToken: string;
    tenantId: string;
}
export declare const buildQueue: Queue<any, any, string, any, any, string>;
/**
 * BullMQ Worker for firmware compilation
 */
export declare class BuildWorker {
    private worker;
    private arduinoBuilder;
    private otaUploader;
    constructor();
    /**
     * Process a compilation job
     */
    private processJob;
    /**
     * Update job status in database
     */
    private updateJobStatus;
    /**
     * Gracefully shutdown worker
     */
    shutdown(): Promise<void>;
}
/**
 * Add a new compilation job to the queue
 */
export declare function queueCompilationJob(jobData: CompileJobData): Promise<string>;
/**
 * Get job status
 */
export declare function getJobStatus(jobId: string): Promise<any>;
/**
 * Cancel a job
 */
export declare function cancelJob(jobId: string): Promise<boolean>;
//# sourceMappingURL=buildQueue.d.ts.map