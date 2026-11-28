import crypto from "crypto";
import { Queue } from "bullmq";
import IORedis from "ioredis";

/**
 * TikTok Webhook Handler for Vercel Serverless Functions
 *
 * Endpoints:
 *   POST /api/tiktok/webhook
 *
 * Handles:
 *   1. Handshake challenge (URL verification)
 *   2. Event notifications with X-TikTok-Signature validation
 *   3. Async event processing via BullMQ queue
 *
 * Required env vars:
 *   TIKTOK_CLIENT_SECRET - App Secret from TikTok Developer Console
 *   TIKTOK_WEBHOOK_VERIFY_TOKEN - Optional custom verify token
 *   REDIS_URL - Redis connection string (e.g., rediss://user:pass@host:port)
 */

// ============================================
// REDIS / BULLMQ SETUP (lazy initialization)
// ============================================
let redis = null;
let eventQueue = null;

function getRedis() {
  if (!redis && process.env.REDIS_URL) {
    redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      enableReadyCheck: true,
      lazyConnect: true,
    });
    redis.on("error", (err) => console.error("[Redis] Connection error:", err));
  }
  return redis;
}

function getEventQueue() {
  if (!eventQueue && getRedis()) {
    eventQueue = new Queue("tiktok-events", {
      connection: redis,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    });
    eventQueue.on("error", (err) => console.error("[BullMQ] Queue error:", err));
  }
  return eventQueue;
}

// ============================================
// EVENT PROCESSORS (Worker - run separately)
// ============================================
/**
 * To run workers, create a separate process:
 *
 * ```javascript
 * // worker.js
 * import { Worker } from "bullmq";
 * import IORedis from "ioredis";
 *
 * const redis = new IORedis(process.env.REDIS_URL);
 *
 * new Worker("tiktok-events", async (job) => {
 *   const { event, payload } = job.data;
 *   switch (event) {
 *     case "video.posted": await handleVideoPosted(payload); break;
 *     case "video.delete": await handleVideoDeleted(payload); break;
 *     case "user.info.updated": await handleUserInfoUpdated(payload); break;
 *     case "user.revoke": await handleUserRevoke(payload); break;
 *   }
 * }, { connection: redis, concurrency: 5 });
 * ```
 */

// Placeholder processors (implement your logic)
async function handleVideoPosted(data) {
  const { video_id, create_time, cover_url, share_url, title, description } = data || {};
  console.log("[Worker] Video posted", { video_id, create_time });
  // TODO: Save to DB, notify user, trigger workflow, etc.
  // Example: await db.videos.create({ video_id, title, url: share_url, posted_at: new Date(create_time * 1000) });
}

async function handleVideoDeleted(data) {
  const { video_id } = data || {};
  console.log("[Worker] Video deleted", { video_id });
  // TODO: Soft delete, notify, cleanup
}

async function handleUserInfoUpdated(data) {
  const { open_id, union_id, display_name, avatar_url } = data || {};
  console.log("[Worker] User info updated", { open_id });
  // TODO: Sync profile in DB
}

async function handleUserRevoke(data) {
  const { open_id } = data || {};
  console.log("[Worker] User revoked access", { open_id });
  // TODO: Delete tokens, revoke sessions, notify user
}

// ============================================
// MAIN HANDLER
// ============================================
export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const verifyToken = process.env.TIKTOK_WEBHOOK_VERIFY_TOKEN;

  if (!clientSecret) {
    console.error("[TikTok Webhook] TIKTOK_CLIENT_SECRET not configured");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  // Get raw body for signature verification
  const rawBody = JSON.stringify(req.body);
  const signature = req.headers["x-tiktok-signature"] || req.headers["X-TikTok-Signature"];

  // 1. HANDSHAKE: TikTok sends { "challenge": "random-string" }
  if (req.body && typeof req.body.challenge === "string") {
    console.log("[TikTok Webhook] Challenge received", { challenge: req.body.challenge });

    // Optional: verify custom verify_token if configured AND provided in query
    if (verifyToken && req.query.verify_token && req.query.verify_token !== verifyToken) {
      console.warn("[TikTok Webhook] Invalid verify_token", {
        expected: verifyToken,
        received: req.query.verify_token
      });
      return res.status(403).send("Forbidden");
    }

    // Respond with challenge as plain text (REQUIRED by TikTok)
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(req.body.challenge);
  }

  // 2. EVENT NOTIFICATIONS: Validate signature
  if (!signature) {
    console.warn("[TikTok Webhook] Missing X-TikTok-Signature header");
    return res.status(401).json({ error: "Missing signature" });
  }

  // Verify HMAC-SHA256 signature
  const expectedSignature = "sha256=" + crypto
    .createHmac("sha256", clientSecret)
    .update(rawBody)
    .digest("base64");

  // Timing-safe comparison
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    console.warn("[TikTok Webhook] Invalid signature", {
      received: signature,
      expected: expectedSignature
    });
    return res.status(401).json({ error: "Invalid signature" });
  }

  // 3. QUEUE EVENT FOR ASYNC PROCESSING
  const event = req.body;
  console.log("[TikTok Webhook] Valid event received, queueing", {
    eventType: event.event,
    eventId: event.event_id,
    timestamp: event.timestamp
  });

  const queue = getEventQueue();
  if (queue) {
    try {
      await queue.add(event.event, { event: event.event, payload: event.data }, {
        jobId: event.event_id, // Idempotency: TikTok may retry with same event_id
      });
    } catch (err) {
      console.error("[TikTok Webhook] Failed to queue event", { error: err.message });
      // Don't fail the webhook - log and continue (TikTok will retry)
    }
  } else {
    console.warn("[TikTok Webhook] Redis not configured, processing inline (not recommended for production)");
    // Fallback: process inline (blocking)
    switch (event.event) {
      case "video.posted": await handleVideoPosted(event.data); break;
      case "video.delete": await handleVideoDeleted(event.data); break;
      case "user.info.updated": await handleUserInfoUpdated(event.data); break;
      case "user.revoke": await handleUserRevoke(event.data); break;
    }
  }

  // Acknowledge receipt (must respond 2xx within 3s)
  return res.status(200).json({ received: true, queued: !!queue });
}

// Export for health check
export { getRedis, getEventQueue };// force deploy Sat Nov 28 01:13:13     2026
