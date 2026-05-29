/**
 * Pull the N most recent inbox messages and run them through the classifier.
 * Prints from/subject + the parsed JSON classification for each.
 *
 * Usage: pnpm exec tsx scripts/classify-test.ts [count]
 */
import 'dotenv/config'
import {
  fetchMessage,
  listRecentInbox,
  makeGmailClient,
  parseMessage,
} from '../src/integrations/gmail/client.js'
import { classify } from '../src/core/classifier.js'

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? '3')

  const gmail = makeGmailClient()
  const listed = await listRecentInbox(gmail, {
    newerThanDays: 7,
    maxResults: count,
  })

  console.log(`Found ${listed.length} message(s) to classify\n`)

  for (let i = 0; i < listed.length; i++) {
    const entry = listed[i]
    if (!entry) continue
    const raw = await fetchMessage(gmail, entry.id)
    const parsed = parseMessage(raw)

    console.log(`\n========== Email ${i + 1}/${listed.length} ==========`)
    console.log(
      `From:    ${parsed.from.name ? `${parsed.from.name} <${parsed.from.email}>` : parsed.from.email}`,
    )
    console.log(`Subject: ${parsed.subject}`)
    console.log(`Date:    ${parsed.receivedAt.toISOString()}`)
    console.log(
      `Body:    ${parsed.bodyText.slice(0, 150).replace(/\n/g, ' ')}${parsed.bodyText.length > 150 ? '...' : ''}`,
    )
    if (parsed.attachments.length > 0) {
      console.log(
        `Atts:    ${parsed.attachments.map((a) => a.filename).join(', ')}`,
      )
    }

    try {
      const result = await classify({
        from: parsed.from,
        subject: parsed.subject,
        bodyText: parsed.bodyText,
        attachments: parsed.attachments.map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
        })),
      })
      console.log('\nClassification:')
      console.log(JSON.stringify(result, null, 2))
    } catch (err) {
      console.log(
        '❌ Classification failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
