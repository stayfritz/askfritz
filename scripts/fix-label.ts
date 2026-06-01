import 'dotenv/config'
import { makeGmailClient } from '../src/integrations/gmail/client.js'
import {
  setFritzState,
  type FritzState,
} from '../src/integrations/gmail/labels.js'

const messageId = process.argv[2]
const state = process.argv[3] as FritzState | undefined
if (!messageId || !state) {
  console.error(
    'Usage: pnpm exec tsx scripts/fix-label.ts <message_id> <state>',
  )
  console.error(
    'States: seen, draft-pending, forward-pending, replied, forwarded, discarded',
  )
  process.exit(1)
}

const gmail = makeGmailClient()
await setFritzState(gmail, messageId, state)
console.log(`Label on ${messageId} set to Fritz/${state}`)
