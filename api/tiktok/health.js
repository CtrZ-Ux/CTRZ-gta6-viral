import { getRedis } from "./webhook.js";

/**
 * Health Check Endpoint
 *
 * GET /api/tiktok/health
 *
 * Returns status of webhook service and Redis connection
 */

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const redis = getRedis();
  let redisStatus = "not configured";
  let redisLatency = null;

  if (redis) {
    try {
      const start = Date.now();
      await redis.ping();
      redisLatency = Date.now() - start;
      redisStatus = "connected";
    } catch (err) {
      redisStatus = "disconnected";
      console.error("[Health] Redis ping failed:", err.message);
    }
  }

  return res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "tiktok-webhook",
    version: "1.0.0",
    redis: {
      status: redisStatus,
      latency_ms: redisLatency,
    },
    queue: "tiktok-events",
  });
}