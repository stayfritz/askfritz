# askfritz — Setup Guide

What you need before askfritz can do real work.

## Prerequisites

- Node.js 20+
- pnpm 9+
- Postgres 16+ (with `pgvector` extension, for later)
- Google Workspace user mailbox (e.g. `fritz@stayfritz.com`)
- Dropbox account with developer app access
- Anthropic API key
- A public URL for Pub/Sub push (in dev: ngrok/cloudflared)

---

## 1. Postgres

Self-hosting on Coolify (recommended):

1. Coolify → New Resource → Database → PostgreSQL 16
2. Create database `askfritz`
3. Copy connection URL → `DATABASE_URL` in `.env`
4. Connect once and enable pgvector (for later):
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

Run migrations:
```bash
pnpm db:migrate
```

---

## 2. Gmail API + Pub/Sub Push

Used for inbound notification AND outbound sending. Mailbox: `fritz@stayfritz.com`.

### 2.1 Google Cloud Project
- console.cloud.google.com → Create project, e.g. `askfritz-fritz`
- Note project ID

### 2.2 Enable APIs
APIs & Services → Library → enable:
- Gmail API
- Cloud Pub/Sub API

### 2.3 Pub/Sub Topic + Subscription
- Pub/Sub → Topics → Create topic `gmail-push`
- Permissions → grant `gmail-api-push@system.gserviceaccount.com` the `Pub/Sub Publisher` role
- Topic → Subscriptions → Create:
  - Name: `gmail-push-sub`
  - Delivery type: **Push**
  - Endpoint URL: `https://YOUR_PUBLIC_URL/webhooks/gmail`
  - (Optional) Enable authentication; askfritz will verify the JWT

### 2.4 OAuth 2.0 Client
- APIs & Services → Credentials → Create OAuth Client ID
- Type: Desktop (for one-time refresh-token fetch) or Web (with redirect URI)
- Note `client_id` and `client_secret`

### 2.5 Authorize fritz@stayfritz.com and capture refresh token
Run the auth helper (TBD: `scripts/auth/gmail.ts`):
- Log in as `fritz@stayfritz.com`
- Scope: `https://www.googleapis.com/auth/gmail.modify`
- Approve → refresh token printed

### 2.6 Env

```
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_USER=fritz@stayfritz.com
GMAIL_PUBSUB_TOPIC=projects/<project-id>/topics/gmail-push
```

### 2.7 Watch
On boot, askfritz calls `gmail.users.watch()` to register for Pub/Sub notifications (auto-renewed every 24h).

---

## 3. Dropbox App

Storage root: `/fritzai/` in the connected Dropbox account.

- dropbox.com/developers/apps → Create app
  - API: Scoped access
  - Type: Full Dropbox (or App folder for sandboxed)
  - Name: `askfritz-fritz` (or similar)
- Permissions tab → check:
  - `files.metadata.write`, `files.metadata.read`
  - `files.content.write`, `files.content.read`
- Submit permissions
- Settings tab → note `App key` + `App secret`
- Generate refresh token (script TBD: `scripts/auth/dropbox.ts`)

Env:
```
DROPBOX_APP_KEY=...
DROPBOX_APP_SECRET=...
DROPBOX_REFRESH_TOKEN=...
DROPBOX_ROOT=/fritzai
```

---

## 4. Anthropic API Key

- console.anthropic.com → Settings → API Keys → Create
- Env: `ANTHROPIC_API_KEY=...`

---

## 5. Boot

```bash
cp .env.example .env   # fill in values
pnpm install
pnpm db:migrate
pnpm dev
```

Health check:
```bash
curl http://localhost:3000/health
```

---

## 6. Expose for Pub/Sub Push

- **Dev:** `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`
- **Prod:** deploy to Coolify, expose via Cloudflare proxy

Update the Pub/Sub subscription endpoint URL to your public URL after deployment.
