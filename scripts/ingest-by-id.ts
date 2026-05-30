import 'dotenv/config'
import {
  fetchMessage,
  makeGmailClient,
  parseMessage,
} from '../src/integrations/gmail/client.js'
import { ingestMessage } from '../src/core/ingestion.js'

async function main() {
  const ids = process.argv.slice(2)
  if (ids.length === 0) {
    console.error('Usage: tsx scripts/ingest-by-id.ts <gmail-message-id> [...]')
    process.exit(1)
  }
  const gmail = makeGmailClient()
  for (const id of ids) {
    try {
      const raw = await fetchMessage(gmail, id)
      const parsed = parseMessage(raw)
      const result = await ingestMessage(parsed)
      console.log(JSON.stringify(result, null, 2))
    } catch (err) {
      console.error('failed for', id, err)
    }
  }
  process.exit(0)
}

main()
