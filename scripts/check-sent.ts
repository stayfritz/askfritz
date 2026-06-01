import 'dotenv/config'
import { makeGmailClient } from '../src/integrations/gmail/client.js'

const query = process.argv[2] ?? 'in:sent to:rechnung@stayfritz.com'
const gmail = makeGmailClient()
const list = await gmail.users.messages.list({
  userId: 'me',
  q: query,
  maxResults: 10,
})
console.log(`Query: ${query}`)
console.log(`Matches: ${list.data.messages?.length ?? 0}`)
for (const m of list.data.messages ?? []) {
  const g = await gmail.users.messages.get({
    userId: 'me',
    id: m.id!,
    format: 'metadata',
    metadataHeaders: ['Subject', 'To', 'Date'],
  })
  const h = g.data.payload?.headers ?? []
  console.log({
    subj: h.find((x) => x.name === 'Subject')?.value,
    to: h.find((x) => x.name === 'To')?.value,
    date: h.find((x) => x.name === 'Date')?.value,
  })
}
