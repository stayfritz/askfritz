/**
 * Generate a Google OAuth refresh token with BOTH Gmail + Calendar scopes.
 *
 * Why: the original GMAIL_REFRESH_TOKEN was issued with Gmail scopes only.
 * To let Fritz also create Calendar events you need a new token with both.
 *
 * Usage:
 *   1. In GCP Console → APIs & Services → Library, enable the
 *      "Google Calendar API" for the same project that already has Gmail.
 *   2. In GCP Console → APIs & Services → OAuth consent screen, add scopes:
 *      - https://www.googleapis.com/auth/gmail.modify
 *      - https://www.googleapis.com/auth/gmail.send
 *      - https://www.googleapis.com/auth/calendar.events
 *      - https://www.googleapis.com/auth/calendar.readonly
 *      (gmail.modify + gmail.send cover everything Fritz already does)
 *   3. Run:  pnpm exec tsx scripts/google-auth.ts
 *   4. Open the printed URL in your browser, approve, copy the `code=...`
 *      param from the redirect URL.
 *   5. Re-run with the code:
 *        pnpm exec tsx scripts/google-auth.ts <code>
 *   6. Paste the printed refresh_token into .env (overwriting GMAIL_REFRESH_TOKEN).
 *   7. Redeploy on Coolify so the new token is picked up.
 */
import 'dotenv/config'
import { google } from 'googleapis'

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
]

// Out-of-band flow: Google shows the code on a page after consent.
// "urn:ietf:wg:oauth:2.0:oob" is being deprecated for new clients, so we
// prefer http://localhost — paste the redirected URL back into the script.
const REDIRECT = 'http://localhost'

async function main(): Promise<void> {
  const clientId = process.env.GMAIL_CLIENT_ID
  const clientSecret = process.env.GMAIL_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    console.error('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env')
    process.exit(1)
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT)

  const codeArg = process.argv[2]
  if (!codeArg) {
    const url = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // forces re-issue with refresh_token even if user already approved
      scope: SCOPES,
    })
    console.log('1. Open this URL in your browser:\n')
    console.log(url)
    console.log(
      '\n2. After approving you will be redirected to http://localhost/?code=... (page will fail to load — that is fine).',
    )
    console.log(
      '3. Copy the value of the `code` URL parameter and re-run:\n   pnpm exec tsx scripts/google-auth.ts <code>',
    )
    return
  }

  const { tokens } = await oauth2.getToken(decodeURIComponent(codeArg))
  if (!tokens.refresh_token) {
    console.error(
      '❌ No refresh_token returned. This usually means you already granted access to this client before. Revoke access at https://myaccount.google.com/permissions and re-run the script.',
    )
    console.error('Raw response:', tokens)
    process.exit(1)
  }

  console.log('✅ Tokens received.\n')
  console.log('Granted scopes:', tokens.scope)
  console.log('\n📋 Paste this into .env (overwriting the old value):\n')
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`)
  console.log(
    '\nDeploy/restart the server, then test with: "Trag mir morgen 10 Uhr einen Test-Termin ein."',
  )
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
