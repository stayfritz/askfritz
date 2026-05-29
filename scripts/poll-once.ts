/**
 * Run exactly one Gmail poll cycle (no interval), useful for testing.
 *
 * Usage: pnpm exec tsx scripts/poll-once.ts
 */
import 'dotenv/config'
import { syncConfigToDb } from '../src/core/sync-config.js'
import { GmailPoller } from '../src/core/poller.js'

async function main(): Promise<void> {
  await syncConfigToDb()
  const poller = new GmailPoller()
  const result = await poller.pollOnce()
  console.log('Poll result:', result)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
