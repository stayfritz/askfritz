# Deploy to Coolify

Target: the same Coolify server that already hosts `askfritz-db` (Hetzner CAX11). One container running the app, talking to the internal Postgres URL.

## Prerequisites

- GitHub repo accessible by Coolify (private repo needs Coolify's GitHub App installed)
- The `askfritz-db` Postgres service is running in Coolify
- Internal DATABASE_URL of the DB (visible in Coolify DB Configuration — uses Docker container hostname, e.g. `postgres://askfritz:PASS@hkwy.../askfritz`)

## 1. Connect GitHub to Coolify

If not already done:

1. Coolify → **Sources** → **Add** → **GitHub App**
2. Follow the OAuth flow → installs Coolify App on your GitHub account/org (`stayfritz`)
3. Select repo `askfritz` as accessible

## 2. New Application in Coolify

1. Open project `askfritz` (same project as the DB)
2. **+ New Resource** → **Application** → **Public Repository** (or **GitHub App** if you connected it)
3. **Repository URL:** `https://github.com/stayfritz/askfritz`
4. **Branch:** `main`
5. **Build Pack:** **Dockerfile**
6. **Dockerfile location:** `Dockerfile` (root, default)
7. **Port:** `3000`
8. **Domain:** optional — `askfritz.stayfritz.com` (Cloudflare DNS A record to server IP + auto-https via Coolify)

## 3. Environment Variables

In the Application → **Environment Variables** tab, add ALL of these (paste values from your local `.env`, with one critical change):

```
# DATABASE_URL: use INTERNAL Coolify hostname (the Docker container alias),
# NOT the public IP. App + DB in same Coolify can talk on the Docker network.
DATABASE_URL=postgres://askfritz:PASSWORD@<INTERNAL_HOST>:5432/askfritz

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Gmail (read mailbox)
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_USER=thomas.langenberg@stayfritz.com
GMAIL_PUBSUB_TOPIC=

# Dropbox
DROPBOX_APP_KEY=...
DROPBOX_APP_SECRET=...
DROPBOX_REFRESH_TOKEN=...
DROPBOX_ROOT=/fritzai

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=...

# Server
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
```

The internal DATABASE_URL host is the Coolify-generated container name (the random string you saw earlier, e.g. `hkwyhlvfplir186s2qjm1x5w`).

## 4. Deploy

- **Deploy** button in Coolify → builds the image, runs `migrations` on boot via the server's bootstrap, starts the app
- Watch the deploy logs:
  - `migrations applied`
  - `domains synced count=1`
  - `gmail poller started`
  - `askfritz listening port=3000`
  - `telegram bot started`

## 5. Close the public Postgres port (security)

Once the app is in Coolify talking to DB via internal hostname, the public 5432 port on the host is no longer needed:

- Coolify → DB `askfritz-db` → Configuration → Network → **Ports Mappings** → leeren
- Save → Restart

DB is then only reachable from inside Coolify's Docker network. For occasional manual psql, SSH-tunnel into the server first.

## 6. Stop local `pnpm dev`

Once Coolify deploy is healthy and Telegram bot responds, your local `pnpm dev` is redundant. Stop it — the Coolify instance runs 24/7.

## Updating later

- Push to `main` branch on GitHub → Coolify auto-redeploys (if Auto Deploy is enabled in Application Settings)
- Or: manual **Redeploy** button after pushing

## Troubleshooting

- **Build fails:** check Dockerfile syntax + that `pnpm-lock.yaml` is committed
- **`migrations applied` not in log → `bootstrap failed`:** DATABASE_URL wrong (internal hostname needed, not external IP)
- **No Telegram bot started:** `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_USER_ID` missing in env
- **Gmail polling errors:** `GMAIL_REFRESH_TOKEN` revoked (re-run the OAuth Playground flow, paste new token)
- **Two bots active:** local `pnpm dev` still running. Telegram doesn't support two long-polling clients on the same bot — stop local dev.
