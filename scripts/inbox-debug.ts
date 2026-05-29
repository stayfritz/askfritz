import 'dotenv/config'
import { makeGmailClient } from '../src/integrations/gmail/client.js'

async function main(): Promise<void> {
  const gmail = makeGmailClient()
  const queries = [
    'in:inbox newer_than:30d',
    'newer_than:7d',
    'newer_than:30d',
    'is:unread newer_than:30d',
    'label:inbox',
  ]

  for (const q of queries) {
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 5,
    })
    console.log(`Query: "${q}" -> ${data.messages?.length ?? 0} msg(s), resultSizeEstimate=${data.resultSizeEstimate}`)
  }

  // also show available labels
  const labels = await gmail.users.labels.list({ userId: 'me' })
  console.log('\nLabels:')
  for (const label of labels.data.labels ?? []) {
    console.log(`  ${label.id} | type: ${label.type} | name: ${label.name}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
