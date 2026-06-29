import { loadConfig } from '@paedavic/config';
import type { ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';

/**
 * Create a Redis connection for BullMQ. `maxRetriesPerRequest: null` is required
 * by BullMQ for blocking commands. The cast bridges the duplicate ioredis type
 * copies that pnpm isolation creates (bullmq bundles its own).
 */
export function createRedisConnection(): ConnectionOptions {
  return new IORedis(loadConfig().REDIS_URL, {
    maxRetriesPerRequest: null,
  }) as unknown as ConnectionOptions;
}
