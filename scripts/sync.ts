import 'dotenv/config'
import { syncConfigToDb } from '../src/core/sync-config.js'

async function main(): Promise<void> {
  console.log('Syncing config → DB...')
  await syncConfigToDb()
  console.log('Sync complete.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Sync failed:', err)
    process.exit(1)
  })
