/**
 * Exchange a Dropbox authorization code for a refresh token.
 *
 * Usage:
 *   1. Open in browser (replace YOUR_APP_KEY):
 *      https://www.dropbox.com/oauth2/authorize?client_id=YOUR_APP_KEY&response_type=code&token_access_type=offline
 *   2. Approve → copy the auth code from the page.
 *   3. Run: pnpm exec tsx scripts/dropbox-auth.ts <auth_code>
 *   4. Paste the printed refresh_token into .env as DROPBOX_REFRESH_TOKEN.
 */
import 'dotenv/config'

async function main(): Promise<void> {
  const code = process.argv[2]
  if (!code) {
    console.error(
      'Usage: pnpm exec tsx scripts/dropbox-auth.ts <authorization_code>',
    )
    process.exit(1)
  }

  const clientId = process.env.DROPBOX_APP_KEY
  const clientSecret = process.env.DROPBOX_APP_SECRET
  if (!clientId || !clientSecret) {
    console.error('DROPBOX_APP_KEY and DROPBOX_APP_SECRET must be set in .env')
    process.exit(1)
  }

  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  const data = (await response.json()) as Record<string, unknown>

  if (!response.ok) {
    console.error('❌ Dropbox returned error:')
    console.error(JSON.stringify(data, null, 2))
    process.exit(1)
  }

  console.log('✅ Dropbox response:')
  console.log(JSON.stringify(data, null, 2))
  console.log('\n📋 Paste this into your .env:')
  console.log(`DROPBOX_REFRESH_TOKEN=${data.refresh_token}`)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
