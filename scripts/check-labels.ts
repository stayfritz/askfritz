import 'dotenv/config'
import { makeGmailClient } from '../src/integrations/gmail/client.js'

const messageId = process.argv[2] ?? '19e80a353a9a226a'

const gmail = makeGmailClient()
const r = await gmail.users.messages.get({
  userId: 'me',
  id: messageId,
  format: 'minimal',
})
const labelIds = r.data.labelIds ?? []
const all = await gmail.users.labels.list({ userId: 'me' })
const allLabels = all.data.labels ?? []

const labelNames = labelIds.map(
  (id) => allLabels.find((l) => l.id === id)?.name ?? id,
)
console.log(`\nMessage ${messageId} labels:`)
console.log(' ', labelNames)

const fritzLabels = allLabels
  .filter((l) => l.name?.startsWith('Fritz/'))
  .map((l) => l.name)
console.log('\nExisting Fritz/* labels in account:')
console.log(' ', fritzLabels.length ? fritzLabels : '(none)')
