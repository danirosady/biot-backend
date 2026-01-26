import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { ArduinoBuilder } from '../compiler/arduinoBuilder';
import { OtaUploader } from '../compiler/otaUploader';
import { prisma } from '../server/prisma';

// Job data interface
export interface CompileJobData {
  jobId: string; // Database CompileJob ID
  code: string;
  boardType: string;
  deviceId: string;
  version: string;
  tbToken: string; // Tenant admin token
  tenantId: string;
}

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null, // Required for BullMQ
};

// Create Redis connection
const connection = new Redis(redisConfig);

// Create BullMQ queue
export const buildQueue = new Queue('firmware-builds', { connection });

/**
 * BullMQ Worker for firmware compilation
 */
export class BuildWorker {
  private worker: Worker;
  private arduinoBuilder: ArduinoBuilder;
  private otaUploader: OtaUploader;

  constructor() {
    this.arduinoBuilder = new ArduinoBuilder();
    this.otaUploader = new OtaUploader();

    // Create worker
    this.worker = new Worker(
      'firmware-builds',
      async (job: Job<CompileJobData>) => {
        return await this.processJob(job);
      },
      {
        connection,
        concurrency: 2, // Process up to 2 jobs simultaneously
      }
    );

    // Event handlers
    this.worker.on('completed', (job) => {
      console.log(`✅ Job ${job.id} completed successfully`);
    });

    this.worker.on('failed', (job, error) => {
      console.error(`❌ Job ${job?.id} failed:`, error.message);
    });

    this.worker.on('error', (error) => {
      console.error('Worker error:', error);
    });

    console.log('🚀 Build worker started');
  }

  /**
   * Process a compilation job
   */
  private async processJob(job: Job<CompileJobData>): Promise<any> {
    const { jobId, code, boardType, deviceId, version, tbToken, tenantId } = job.data;

    try {
      // Update job status to 'compiling'
      await this.updateJobStatus(jobId, 'compiling', 'Starting compilation...');
      await job.updateProgress(10);

      // Step 1: Compile Arduino code
      console.log(`📦 Compiling firmware for device ${deviceId}`);
      const buildResult = await this.arduinoBuilder.compile({
        code,
        boardType,
      });

      if (!buildResult.success || !buildResult.binPath) {
        throw new Error(buildResult.error || 'Compilation failed');
      }

      // Update progress
      await this.updateJobStatus(jobId, 'compiling', buildResult.logs.join('\n'));
      await job.updateProgress(50);

      // Step 2: Copy binary to permanent storage
      const storageDir = process.env.FIRMWARE_STORAGE_PATH || './public/firmware';
      const fileName = `firmware-${deviceId}-${version}-${Date.now()}.bin`;
      
      console.log(`💾 Copying firmware to storage: ${fileName}`);
      const storedBinPath = await this.arduinoBuilder.copyToStorage(
        buildResult.binPath,
        storageDir,
        fileName
      );

      await job.updateProgress(60);

      // Step 3: Create firmware record in database
      const { size } = await (await import('fs/promises')).stat(storedBinPath);
      const firmware = await prisma.firmware.create({
        data: {
          name: `Firmware ${version}`,
          description: `Auto-generated for device ${deviceId}`,
          version,
          filePath: storedBinPath,
          fileSize: size,
          deviceType: 'ESP32',
          isActive: true,
          tenantId,
        },
      });

      await job.updateProgress(70);

      // Step 4: Upload to ThingsBoard OTA
      console.log(`📤 Uploading firmware to ThingsBoard`);
      await this.updateJobStatus(jobId, 'uploading', 'Uploading firmware to ThingsBoard...');

      const otaResult = await this.otaUploader.uploadAndDeploy({
        binPath: storedBinPath,
        deviceId,
        version,
        title: `Firmware ${version}`,
        description: `Auto-generated from Wiring Studio`,
        tbServer: process.env.THINGSBOARD_BASE_URL!,
        tbToken,
      });

      if (!otaResult.success) {
        throw new Error(otaResult.error || 'OTA upload failed');
      }

      await job.updateProgress(90);

      // Step 5: Update job status to success
      await prisma.compileJob.update({
        where: { id: jobId },
        data: {
          status: 'success',
          logs: [...buildResult.logs, `OTA package ID: ${otaResult.packageId}`].join('\n'),
          firmwareId: firmware.id,
        },
      });

      await job.updateProgress(100);

      // Cleanup temp files
      await this.arduinoBuilder.cleanup();

      console.log(`✅ Job ${jobId} completed successfully`);

      return {
        success: true,
        firmwareId: firmware.id,
        otaPackageId: otaResult.packageId,
      };

    } catch (error: any) {
      console.error(`❌ Job ${jobId} failed:`, error.message);

      // Update job status to failed
      await this.updateJobStatus(jobId, 'failed', error.message);

      // Cleanup temp files
      await this.arduinoBuilder.cleanup();

      throw error;
    }
  }

  /**
   * Update job status in database
   */
  private async updateJobStatus(
    jobId: string,
    status: string,
    logs: string
  ): Promise<void> {
    try {
      await prisma.compileJob.update({
        where: { id: jobId },
        data: {
          status,
          logs,
          ...(status === 'failed' && { errorMsg: logs }),
        },
      });
    } catch (error) {
      console.error('Failed to update job status:', error);
    }
  }

  /**
   * Gracefully shutdown worker
   */
  async shutdown(): Promise<void> {
    await this.worker.close();
    await connection.quit();
    console.log('Worker shut down');
  }
}

/**
 * Add a new compilation job to the queue
 */
export async function queueCompilationJob(
  jobData: CompileJobData
): Promise<string> {
  const job = await buildQueue.add('compile', jobData, {
    attempts: 3, // Retry up to 3 times
    backoff: {
      type: 'exponential',
      delay: 5000, // Start with 5s delay
    },
  });

  return job.id!;
}

/**
 * Get job status
 */
export async function getJobStatus(jobId: string): Promise<any> {
  const job = await buildQueue.getJob(jobId);
  
  if (!job) {
    return { status: 'not_found' };
  }

  const state = await job.getState();
  const progress = job.progress;

  return {
    status: state,
    progress,
    data: job.data,
  };
}

/**
 * Cancel a job
 */
export async function cancelJob(jobId: string): Promise<boolean> {
  const job = await buildQueue.getJob(jobId);
  
  if (job) {
    await job.remove();
    return true;
  }
  
  return false;
}
