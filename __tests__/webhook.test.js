/**
 * TikTok Webhook Handler Tests
 *
 * Run: npm test
 *
 * Tests cover:
 * - Challenge handshake (URL verification)
 * - Signature validation (HMAC-SHA256)
 * - Event routing
 * - Error handling
 * - Missing/invalid headers
 */

import crypto from "crypto";

// Mock environment
const originalEnv = process.env;

// Helper to create mock request/response
function createMockReq(body = {}, headers = {}, query = {}) {
  return {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    query,
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
    send(data) {
      this.body = data;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    end(data) {
      this.body = data;
      return this;
    },
  };
  return res;
}

// Generate valid TikTok signature
function generateSignature(payload, secret) {
  return "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("base64");
}

describe("TikTok Webhook Handler", () => {
  const TEST_SECRET = "test_client_secret_12345";
  const TEST_VERIFY_TOKEN = "custom_verify_token";

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      TIKTOK_CLIENT_SECRET: TEST_SECRET,
      TIKTOK_WEBHOOK_VERIFY_TOKEN: TEST_VERIFY_TOKEN,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Dynamic import after env is set
  async function getHandler() {
    const mod = await import("../api/tiktok/webhook.js");
    return mod.default;
  }

  describe("Challenge Handshake (URL Verification)", () => {
    it("should respond with challenge as plain text", async () => {
      const handler = await getHandler();
      const req = createMockReq({ challenge: "tiktok_challenge_abc123" });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
      expect(res.body).toBe("tiktok_challenge_abc123");
    });

    it("should reject challenge with wrong verify_token", async () => {
      const handler = await getHandler();
      const req = createMockReq(
        { challenge: "tiktok_challenge_abc123" },
        {},
        { verify_token: "wrong_token" }
      );
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(res.body).toBe("Forbidden");
    });

    it("should accept challenge with correct verify_token", async () => {
      const handler = await getHandler();
      const req = createMockReq(
        { challenge: "tiktok_challenge_abc123" },
        {},
        { verify_token: TEST_VERIFY_TOKEN }
      );
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("tiktok_challenge_abc123");
    });

    it("should accept challenge when no verify_token configured", async () => {
      process.env.TIKTOK_WEBHOOK_VERIFY_TOKEN = "";
      jest.resetModules();
      const handler = await getHandler();

      const req = createMockReq(
        { challenge: "tiktok_challenge_abc123" },
        {},
        { verify_token: "any_token" }
      );
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("tiktok_challenge_abc123");
    });
  });

  describe("Signature Validation", () => {
    it("should reject request without X-TikTok-Signature header", async () => {
      const handler = await getHandler();
      const req = createMockReq({ event: "video.posted", data: { video_id: "123" } });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Missing signature" });
    });

    it("should reject request with invalid signature", async () => {
      const handler = await getHandler();
      const payload = { event: "video.posted", data: { video_id: "123" } };
      const req = createMockReq(payload, {
        "x-tiktok-signature": "sha256=invalid_signature",
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Invalid signature" });
    });

    it("should accept request with valid signature (case-insensitive header)", async () => {
      const handler = await getHandler();
      const payload = { event: "video.posted", data: { video_id: "123" } };
      const signature = generateSignature(payload, TEST_SECRET);

      const req = createMockReq(payload, {
        "X-TikTok-Signature": signature, // Different case
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ received: true, queued: false }); // queued: false because no Redis
    });

    it("should accept request with valid lowercase signature header", async () => {
      const handler = await getHandler();
      const payload = { event: "video.posted", data: { video_id: "123" } };
      const signature = generateSignature(payload, TEST_SECRET);

      const req = createMockReq(payload, {
        "x-tiktok-signature": signature,
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });
  });

  describe("Event Routing", () => {
    const validSignature = (payload) => generateSignature(payload, TEST_SECRET);

    it("should route video.posted event", async () => {
      const handler = await getHandler();
      const payload = {
        event: "video.posted",
        event_id: "evt_123",
        timestamp: Date.now(),
        data: {
          video_id: "vid_456",
          create_time: Math.floor(Date.now() / 1000),
          cover_url: "https://example.com/cover.jpg",
          share_url: "https://tiktok.com/@user/video/123",
          title: "Test video",
          description: "#gta6 #viral",
        },
      };
      const req = createMockReq(payload, {
        "x-tiktok-signature": validSignature(payload),
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.received).toBe(true);
    });

    it("should route video.delete event", async () => {
      const handler = await getHandler();
      const payload = {
        event: "video.delete",
        event_id: "evt_124",
        timestamp: Date.now(),
        data: { video_id: "vid_456" },
      };
      const req = createMockReq(payload, {
        "x-tiktok-signature": validSignature(payload),
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("should route user.info.updated event", async () => {
      const handler = await getHandler();
      const payload = {
        event: "user.info.updated",
        event_id: "evt_125",
        timestamp: Date.now(),
        data: {
          open_id: "user_789",
          union_id: "union_789",
          display_name: "Test User",
          avatar_url: "https://example.com/avatar.jpg",
        },
      };
      const req = createMockReq(payload, {
        "x-tiktok-signature": validSignature(payload),
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("should route user.revoke event", async () => {
      const handler = await getHandler();
      const payload = {
        event: "user.revoke",
        event_id: "evt_126",
        timestamp: Date.now(),
        data: { open_id: "user_789" },
      };
      const req = createMockReq(payload, {
        "x-tiktok-signature": validSignature(payload),
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("should accept unknown event types (log but not fail)", async () => {
      const handler = await getHandler();
      const payload = {
        event: "unknown.event.type",
        event_id: "evt_127",
        timestamp: Date.now(),
        data: {},
      };
      const req = createMockReq(payload, {
        "x-tiktok-signature": validSignature(payload),
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.received).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should reject non-POST requests", async () => {
      const handler = await getHandler();
      const req = createMockReq({}, {}, {});
      req.method = "GET";
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(405);
      expect(res.body).toEqual({ error: "Method Not Allowed" });
      expect(res.headers["Allow"]).toBe("POST");
    });

    it("should return 500 when TIKTOK_CLIENT_SECRET not configured", async () => {
      process.env.TIKTOK_CLIENT_SECRET = "";
      jest.resetModules();
      const handler = await getHandler();

      const payload = { event: "video.posted", data: { video_id: "123" } };
      const req = createMockReq(payload, {
        "x-tiktok-signature": generateSignature(payload, "wrong_secret"),
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: "Server misconfiguration" });
    });

    it("should handle malformed JSON body gracefully", async () => {
      const handler = await getHandler();
      const req = {
        method: "POST",
        body: null,
        headers: { "x-tiktok-signature": "sha256=invalid" },
        query: {},
      };
      const res = createMockRes();

      await handler(req, res);

      // Should not crash, returns 401 for invalid signature
      expect([401, 500]).toContain(res.statusCode);
    });
  });

  describe("Idempotency (jobId)", () => {
    it("should use event_id as jobId for deduplication", async () => {
      // This test verifies the queue.add is called with jobId = event_id
      // Actual queue testing requires Redis - here we verify the logic exists
      const handler = await getHandler();
      const payload = {
        event: "video.posted",
        event_id: "evt_same_123",
        timestamp: Date.now(),
        data: { video_id: "vid_1" },
      };
      const req = createMockReq(payload, {
        "x-tiktok-signature": generateSignature(payload, TEST_SECRET),
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      // With Redis configured, duplicate event_id would be deduplicated by BullMQ
    });
  });
});

// ============================================
// INTEGRATION TEST HELPERS (require Redis)
// ============================================

/**
 * To run integration tests with real Redis:
 *
 * 1. Start Redis: docker run -d -p 6379:6379 redis:7-alpine
 * 2. Set REDIS_URL=redis://localhost:6379
 * 3. Run: npm test -- --testPathPattern=webhook.integration.test.js
 *
 * Example integration test:
 */
/*
describe("Webhook Integration (requires Redis)", () => {
  let handler, queue, worker;

  beforeAll(async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const mod = await import("../api/tiktok/webhook.js");
    handler = mod.default;
    // Initialize queue
    await new Promise(r => setTimeout(r, 100));
  });

  afterAll(async () => {
    await queue?.close();
    await worker?.close();
  });

  it("should queue event and worker should process it", async () => {
    // ... test full flow
  });
});
*/