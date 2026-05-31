/**
 * Re-ingest a single Gmail message by id.
 *
 * Used when:
 *   - the classifier was buggy when the mail was first processed, and we want
 *     to re-run with the current (fixed) prompt
 *   - we want to retroactively trigger forward / draft flows for a mail that
 *     was misclassified
 *
 * Idempotency guard in ingestion.ts checks documents.source_id; this script
 * therefore DELETES the existing document + any related pending task first.
 *
 * Usage:
 *   pnpm exec tsx scripts/re-ingest.ts <gmail_message_id>
 */
import 'dotenv/config'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/integrations/postgres/db.js'
import { documents, tasks } from '../src/integrations/postgres/schema.js'
import {
  fetchMessage,
  makeGmailClient,
  parseMessage,
} from '../src/integrations/gmail/client.js'
import { ingestMessage } from '../src/core/ingestion.js'

async function main(): Promise<void> {
  const messageId = process.argv[2]
  if (!messageId) {
    console.error('Usage: pnpm exec tsx scripts/re-ingest.ts <gmail_message_id>')
    process.exit(1)
  }

  // 1. Find existing document(s) for this message_id
  const existing = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(eq(documents.source, 'gmail'), eq(documents.sourceId, messageId)),
    )

  for (const doc of existing) {
    // Clean up related pending tasks
    const deletedTasks = await db
      .delete(tasks)
      .where(
        and(
          eq(tasks.relatedDocumentId, doc.id),
          eq(tasks.status, 'pending_user'),
        ),
      )
      .returning({ id: tasks.id })
    console.log(`Deleted ${deletedTasks.length} pending task(s) for doc ${doc.id.slice(0, 8)}`)
    await db.delete(documents).where(eq(documents.id, doc.id))
    console.log(`Deleted document ${doc.id.slice(0, 8)}`)
  }

  // 2. Fetch + parse + re-ingest with current code
  const gmail = makeGmailClient()
  const raw = await fetchMessage(gmail, messageId)
  const parsed = parseMessage(raw)
  console.log(`\nRe-ingesting: ${parsed.subject}\n  from: ${parsed.from.email}\n  attachments: ${parsed.attachments.length}`)

  const result = await ingestMessage(parsed)
  console.log('\nResult:', JSON.stringify(result, null, 2))

  process.exit(0)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
