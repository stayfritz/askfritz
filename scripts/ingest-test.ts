/**
 * Pull the N most recent inbox messages and run them through full ingestion
 * (classify + persist + upload attachments). Prints what happened.
 *
 * Usage: pnpm exec tsx scripts/ingest-test.ts [count]
 */
import 'dotenv/config'
import {
  fetchMessage,
  listRecentInbox,
  makeGmailClient,
  parseMessage,
} from '../src/integrations/gmail/client.js'
import { ingestMessage } from '../src/core/ingestion.js'

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? '3')

  const gmail = makeGmailClient()
  const listed = await listRecentInbox(gmail, {
    newerThanDays: 7,
    maxResults: count,
  })

  console.log(`Found ${listed.length} message(s) to ingest\n`)

  for (let i = 0; i < listed.length; i++) {
    const entry = listed[i]
    if (!entry) continue

    const raw = await fetchMessage(gmail, entry.id)
    const parsed = parseMessage(raw)

    console.log(`\n========== ${i + 1}/${listed.length} ==========`)
    console.log(`From:    ${parsed.from.email}`)
    console.log(`Subject: ${parsed.subject}`)

    const result = await ingestMessage(parsed)

    console.log(`Status:  ${result.status}`)
    if (result.classification) {
      console.log(`Domain:  ${result.classification.domain_id ?? '(none)'}`)
      console.log(`Topic:   ${result.topicId ?? '(none)'}`)
      console.log(`Intent:  ${result.classification.intent}`)
      console.log(`Urgency: ${result.classification.urgency}`)
    }
    if (result.dropboxPaths && result.dropboxPaths.length > 0) {
      console.log(`Dropbox: ${result.dropboxPaths.join(', ')}`)
    }
    if (result.taskCreated) {
      console.log(`Task:    ✅ pending_user created`)
    }
    if (result.error) {
      console.log(`Error:   ${result.error}`)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
