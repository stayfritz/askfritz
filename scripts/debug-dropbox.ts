import 'dotenv/config'
import { makeDropboxClient } from '../src/integrations/dropbox/client.js'

async function run(): Promise<void> {
  const dbx = makeDropboxClient()
  try {
    const r = await dbx.usersGetCurrentAccount()
    console.log('OK', r.result.email)
  } catch (e) {
    const err = e as {
      status?: number
      error?: unknown
      body?: unknown
      message?: string
    }
    console.log('Status:', err.status)
    console.log('Error keys:', Object.keys(err))
    console.log('Error:', JSON.stringify(err.error, null, 2))
    console.log('Body:', err.body ?? err.message)
  }
}

run()
