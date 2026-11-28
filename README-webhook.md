# TikTok Webhook - Vercel Deployment Guide

## Quick Deploy (2 minutes)

### 1. Install Vercel CLI
```bash
npm i -g vercel
```

### 2. Login & Link Project
```bash
cd C:\CTRZ-gta6-viral
vercel login
vercel link
```

### 3. Add Environment Variables
```bash
# Required: App Secret from TikTok Developer Console → Your App → Basic Info
vercel env add TIKTOK_CLIENT_SECRET

# Optional: Custom verify token (if configured in TikTok Console → Webhooks)
vercel env add TIKTOK_WEBHOOK_VERIFY_TOKEN

# Optional: Redis for async queue (recommended for production)
vercel env add REDIS_URL
```

### 4. Deploy to Production
```bash
vercel --prod
```

### 5. Copy Webhook URL
Output example: `https://gta6-viral-abc123.vercel.app/api/tiktok/webhook`

### 6. Configure in TikTok Developer Console
1. Go to **Products → Webhooks → Webhook URL**
2. Paste: `https://your-project.vercel.app/api/tiktok/webhook`
3. Click **Verify** → should turn green ✅
4. Select events: `video.posted`, `user.info.updated`, `user.revoke`, etc.
5. Save

---

## Local Development

```bash
# Install deps
npm install

# Copy env example
cp .env.example .env.local
# Edit .env.local with your secrets

# Run local dev server (port 3000)
npm run dev
```

Test locally with ngrok:
```bash
ngrok http 3000
# Use ngrok URL in TikTok Console for testing
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TIKTOK_CLIENT_SECRET` | ✅ Yes | App Secret from TikTok Console |
| `TIKTOK_WEBHOOK_VERIFY_TOKEN` | No | Custom verify token (if set in console) |
| `REDIS_URL` | No* | Redis connection string for BullMQ queue |

> *`REDIS_URL` is optional but **strongly recommended for production**. Without it, events are processed inline (blocking) which can timeout on Vercel's 30s limit.

---

## Architecture

```
┌─────────────┐     POST /api/tiktok/webhook      ┌──────────────────┐
│   TikTok    │ ─────────────────────────────────▶ │  Vercel Function │
│  Webhooks   │ ◀────────────────── 200 OK         │  (api/tiktok/    │
└─────────────┘      challenge / event             │   webhook.js)    │
                                                   └────────┬─────────┘
                                                            │
                                              ┌─────────────┴─────────────┐
                                              ▼                           ▼
                                    ┌─────────────────┐         ┌─────────────────┐
                                    │  Challenge OK   │         │  Valid Event    │
                                    │  (200 + text)   │         │  (queue.add)    │
                                    └─────────────────┘         └────────┬────────┘
                                                                         │
                                                                         ▼
                                                              ┌─────────────────────┐
                                                              │   Redis (Upstash)   │
                                                              │  Queue: tiktok-events│
                                                              └──────────┬──────────┘
                                                                         │
                                                                         ▼
                                                              ┌─────────────────────┐
                                                              │  Worker Process     │
                                                              │  (worker.js)        │
                                                              │  Concurrency: 5     │
                                                              │  Rate limit: 100/m  │
                                                              └─────────────────────┘
```

---

## Event Types Handled

| Event | Description | Data Fields |
|-------|-------------|-------------|
| `video.posted` | User posted a video | `video_id`, `create_time`, `cover_url`, `share_url`, `title`, `description` |
| `video.delete` | User deleted a video | `video_id` |
| `user.info.updated` | User profile changed | `open_id`, `union_id`, `display_name`, `avatar_url` |
| `user.revoke` | User revoked app access | `open_id` |

---

## Signature Verification

The handler validates `X-TikTok-Signature` header using HMAC-SHA256:

```javascript
// TikTok sends: X-TikTok-Signature: sha256=<base64_hmac>
const expected = "sha256=" + crypto
  .createHmac("sha256", clientSecret)
  .update(JSON.stringify(req.body))
  .digest("base64");
```

**Critical:** Uses raw JSON body (not parsed) for verification.

---

## Response Requirements

| Scenario | Response | Timeout |
|----------|----------|---------|
| Challenge (handshake) | `200 OK`, `text/plain`, body = challenge string | < 3s |
| Valid event | `200 OK`, JSON `{ "received": true, "queued": true }` | < 3s |
| Invalid signature | `401 Unauthorized` | < 3s |
| Other errors | Appropriate status | < 3s |

---

## Health Check

```bash
# Check service health
curl https://your-project.vercel.app/api/tiktok/health

# Response:
{
  "status": "ok",
  "timestamp": "2026-11-26T23:30:00.000Z",
  "service": "tiktok-webhook",
  "version": "1.0.0",
  "redis": { "status": "connected", "latency_ms": 12 },
  "queue": "tiktok-events"
}
```

---

## Running the Worker

### Local Development
```bash
# Terminal 1: Start Redis (Docker)
docker run -d -p 6379:6379 redis:7-alpine

# Terminal 2: Set env & run worker
export REDIS_URL=redis://localhost:6379
export TIKTOK_CLIENT_SECRET=your_secret
npm run worker
```

### Production Deployment (Worker)
Deploy `worker.js` as a **background service** on:
- **Railway**: `railway up` (add Redis addon)
- **Render**: Background Worker service
- **Fly.io**: `fly deploy` (with Redis)
- **AWS ECS/Fargate**: Container task

**Required env vars for worker:**
```bash
REDIS_URL=rediss://user:pass@host:port
TIKTOK_CLIENT_SECRET=your_secret  # For API calls back to TikTok
```

---

## Logs & Monitoring

```bash
# View production logs (webhook)
vercel logs https://your-project.vercel.app/api/tiktok/webhook

# Follow real-time logs
vercel logs --follow

# Worker logs (depends on platform)
railway logs
# or
render logs
# or
fly logs
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `We couldn't find your verification signature` | Wrong URL / not responding to challenge | Check URL ends with `/api/tiktok/webhook`, responds 200 + challenge |
| `Invalid signature` | Wrong client secret / body parsing | Use `TIKTOK_CLIENT_SECRET` from console, raw JSON body |
| `405 Method Not Allowed` | GET request to webhook | TikTok only POSTs; ensure no redirects |
| `500 Server Error` | Missing env var | Add `TIKTOK_CLIENT_SECRET` in Vercel dashboard |
| `Queue not initialized` | `REDIS_URL` not set | Add `REDIS_URL` env var (events process inline as fallback) |
| Worker jobs failing | Handler throws error | Check worker logs, fix handler, job will retry (max 5x) |

---

## Project Structure

```
CTRZ-gta6-viral/
├── api/
│   └── tiktok/
│       ├── webhook.js        # Main handler (Vercel function)
│       └── health.js         # Health check endpoint
├── worker.js                 # BullMQ worker (run separately)
├── vercel.json               # Vercel config
├── package.json              # Deps & scripts
├── .env.example              # Env template
├── __tests__/
│   └── webhook.test.js       # Jest unit tests
├── README-webhook.md         # This file
├── terms-of-service.html     # TikTok requirement
├── privacy-policy.html       # TikTok requirement
└── TERMS.md                  # Markdown version
```

---

## Scripts

```bash
# Development
npm run dev          # Vercel dev server (port 3000)
npm run worker       # Start BullMQ worker

# Testing
npm test             # Run Jest unit tests
npm run test:watch   # Watch mode
npm run test:ci      # CI mode with coverage

# Deployment
npm run deploy       # vercel --prod
npm run deploy:preview  # vercel (preview)
```

---

## Next Steps

1. **Implement event handlers** in `worker.js`:
   - Save video metadata to your DB
   - Notify users via email/push
   - Trigger downstream workflows

2. **Add observability**:
   - Metrics (Prometheus/Grafana)
   - Alerting (PagerDuty/Slack)
   - Distributed tracing

3. **Scale**:
   - Increase worker concurrency
   - Add priority queues
   - Separate queues per event type

4. **Security hardening**:
   - IP allowlist (TikTok webhook IPs)
   - Request size limits
   - Rate limiting per user