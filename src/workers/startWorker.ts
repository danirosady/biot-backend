#!/usr/bin/env tsx
/**
 * Start the BullMQ worker
 * Run with: tsx src/workers/startWorker.ts
 */

import { BuildWorker } from './buildQueue';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

console.log('🚀 Starting Wiring Studio Build Worker...');
console.log('Redis:', process.env.REDIS_HOST || 'localhost', ':', process.env.REDIS_PORT || '6379');
console.log('ThingsBoard:', process.env.THINGSBOARD_BASE_URL);
console.log('Arduino CLI:', process.env.ARDUINO_CLI_PATH || 'arduino-cli');

// Create worker instance
const worker = new BuildWorker();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await worker.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await worker.shutdown();
  process.exit(0);
});

console.log('✅ Worker ready and waiting for jobs...');
