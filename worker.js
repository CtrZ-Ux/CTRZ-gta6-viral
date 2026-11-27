/**
 * TikTok Event Worker - BullMQ Processor
 *
 * Run separately from the webhook:
 *   npm run worker
 *
 * Or deploy as a background worker on Railway/Render/Fly.io
 *
 * Required env vars:
 *   REDIS_URL - Redis connection string
 *   TIKTOK_CLIENT_SECRET - For any API calls back to TikTok
 */

import { Worker } from "bullmq";
import IORedis from "ioredis";
import crypto from "crypto";

const REDIS_URL = process.env.REDIS_URL;
const RUN_ONCE = process.argv.includes("--once");

if (!REDIS_URL) {
  console.error("[Worker] REDIS_URL not configured");
  process.exit(1);
}

// Redis connection
const redis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  enableReadyCheck: true,
  lazyConnect: true,
});

redis.on("connect", () => console.log("[Worker] Redis connected"));
redis.on("error", (err) => console.error("[Worker] Redis error:", err));
redis.on("close", () => console.log("[Worker] Redis connection closed"));

// ============================================
// EVENT PROCESSORS
// ============================================

async function handleVideoPosted(data) {
  const { video_id, create_time, cover_url, share_url, title, description } = data || {};
  console.log("[Worker] Processing video.posted", { video_id, create_time });

  // TODO: Implement your logic here
  // Examples:
  // - await db.videos.create({ video_id, title, url: share_url, posted_at: new Date(create_time * 1000) });
  // - await notifyUser(video_id);
  // - await triggerWorkflow(video_id);

  // Simulate async work
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log("[Worker] Completed video.posted", { video_id });
}

async function handleVideoDeleted(data) {
  const { video_id } = data || {};
  console.log("[Worker] Processing video.delete", { video_id });

  // TODO: Implement your logic
  // - await db.videos.update({ video_id }, { deleted: true });
  // - await cleanupFiles(video_id);

  await new Promise(resolve => setTimeout(resolve, 50));
  console.log("[Worker] Completed video.delete", { video_id });
}

async function handleUserInfoUpdated(data) {
  const { open_id, union_id, display_name, avatar_url } = data || {};
  console.log("[Worker] Processing user.info.updated", { open_id });

  // TODO: Implement your logic
  // - await db.users.update({ open_id }, { display_name, avatar_url });

  await new Promise(resolve => setTimeout(resolve, 50));
  console.log("[Worker] Completed user.info.updated", { open_id });
}

async function handleUserRevoke(data) {
  const { open_id } = data || {};
  console.log("[Worker] Processing user.revoke", { open_id });

  // TODO: Implement your logic
  // - await db.tokens.delete({ open_id });
  // - await revokeSessions(open_id);
  // - await notifyUserRevoked(open_id);

  await new Promise(resolve => setTimeout(resolve, 50));
  console.log("[Worker] Completed user.revoke", { open_id });
}

// ============================================
// WORKER INSTANCE
// ============================================

const worker = new Worker(
  "tiktok-events",
  async (job) => {
    const { event, payload } = job.data;
    console.log(`[Worker] Job ${job.id} started`, { event, attempt: job.attemptsMade + 1 });

    const startTime = Date.now();

    try {
      switch (event) {
        case "video.posted":
          await handleVideoPosted(payload);
          break;
        case "video.delete":
          await handleVideoDeleted(payload);
          break;
        case "user.info.updated":
          await handleUserInfoUpdated(payload);
          break;
        case "user.revoke":
          await handleUserRevoke(payload);
          break;
        default:
          console.warn(`[Worker] Unknown event type: ${event}`);
          // Don't throw - mark as completed to avoid infinite retries
          return { skipped: true, reason: "unknown_event" };
      }

      const duration = Date.now() - startTime;
      console.log(`[Worker] Job ${job.id} completed in ${duration}ms`);
      return { success: true, duration };

    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[Worker] Job ${job.id} failed after ${duration}ms`, {
        error: error.message,
        stack: error.stack
      });
      throw error; // Re-throw to trigger retry logic
    }
  },
  {
    connection: redis,
    concurrency: 5, // Process up to 5 jobs concurrently
    limiter: {
      max: 100, // Max 100 jobs per minute (rate limiting)
      duration: 60000,
    },
    // Job options
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  }
);

// ============================================
// EVENT LISTENERS
// ============================================

worker.on("completed", (job, result) => {
  console.log(`[Worker] Job ${job.id} completed`, { result });
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed`, {
    error: err.message,
    attempts: job?.attemptsMade,
    maxAttempts: job?.opts?.attempts
  });
});

worker.on("error", (err) => {
  console.error("[Worker] Worker error:", err);
});

worker.on("stalled", (jobId) => {
  console.warn(`[Worker] Job ${jobId} stalled`);
});

// Graceful shutdown
async function shutdown() {
  console.log("[Worker] Shutting down...");
  await worker.close();
  await redis.quit();
  console.log("[Worker] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ============================================
// RUN ONCE MODE (for GitHub Actions / Cron)
// ============================================

if (RUN_ONCE) {
  console.log("[Worker] Running in --once mode: processing available jobs then exiting");

  await redis.connect();

  // Wait for worker to be ready
  await worker.waitUntilReady();

  // Drain the queue: process all available jobs
  await worker.drain();

  console.log("[Worker] Queue drained, shutting down...");
  await shutdown();
} else {
  console.log("[Worker] Started, waiting for jobs...");
}