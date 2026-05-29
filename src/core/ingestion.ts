import { and, eq } from 'drizzle-orm'
import { db } from '../integrations/postgres/db.js'
import {
  documents,
  tasks,
  threads,
  topics,
} from '../integrations/postgres/schema.js'
import {
  downloadAttachment,
  makeGmailClient,
  type ParsedMessage,
} from '../integrations/gmail/client.js'
import {
  makeDropboxClient,
  uploadFile,
} from '../integrations/dropbox/client.js'
import { classify, type Classification } from './classifier.js'
import { draftReply } from './drafter.js'
import { logger } from '../lib/logger.js'
import { notifyDraft } from '../lib/notifier.js'

export interface IngestionResult {
  messageId: string
  status: 'ingested' | 'skipped' | 'failed'
  classification?: Classification
  topicId?: string | null
  documentId?: string
  dropboxPaths?: string[]
  taskCreated?: boolean
  error?: string
}

/**
 * Idempotent ingestion of a single parsed Gmail message.
 * - Skips if already in documents (by source + sourceId).
 * - Classifies via LLM.
 * - Finds/creates topic.
 * - Uploads attachments to Dropbox.
 * - Inserts document, optional task, upserts thread.
 */
export async function ingestMessage(
  parsed: ParsedMessage,
): Promise<IngestionResult> {
  try {
    const existing = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(eq(documents.source, 'gmail'), eq(documents.sourceId, parsed.id)),
      )
      .limit(1)

    if (existing.length > 0) {
      return { messageId: parsed.id, status: 'skipped' }
    }

    const classification = await classify({
      from: parsed.from,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      attachments: parsed.attachments.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
      })),
    })

    logger.info(
      {
        messageId: parsed.id,
        from: parsed.from.email,
        subject: parsed.subject,
        domain: classification.domain_id,
        topic_hint: classification.topic_hint,
        intent: classification.intent,
        urgency: classification.urgency,
      },
      'classified',
    )

    let topicId: string | null = null
    if (classification.domain_id && classification.topic_hint) {
      topicId = await ensureTopic(
        classification.domain_id,
        classification.topic_hint,
      )
    }

    const dropboxPaths = await uploadAttachments(parsed, classification)

    const [doc] = await db
      .insert(documents)
      .values({
        topicId,
        source: 'gmail',
        sourceId: parsed.id,
        senderPersonId: classification.sender_person_id,
        receivedAt: parsed.receivedAt,
        summary: classification.summary,
        dropboxPath: dropboxPaths[0] ?? null,
        originalSubject: parsed.subject,
        metadata: {
          from_email: parsed.from.email,
          from_name: parsed.from.name ?? null,
          thread_id: parsed.threadId,
          intent: classification.intent,
          urgency: classification.urgency,
          language: classification.language,
          attachments: dropboxPaths,
        },
      })
      .returning({ id: documents.id })

    let taskCreated = false
    if (classification.intent === 'action_required' && doc?.id) {
      let draft: string | null = null
      try {
        draft = await draftReply({
          originalFrom: parsed.from,
          originalSubject: parsed.subject,
          originalBody: parsed.bodyText,
          language: classification.language,
          summary: classification.summary,
        })
      } catch (err) {
        logger.error({ err, messageId: parsed.id }, 'draft generation failed')
      }

      const [task] = await db
        .insert(tasks)
        .values({
          topicId,
          relatedDocumentId: doc.id,
          description: classification.summary,
          status: 'pending_user',
          requiresDecision: true,
          draftContent: draft,
        })
        .returning({ id: tasks.id })
      taskCreated = true

      if (task?.id && draft) {
        await notifyDraft({
          taskId: task.id,
          fromName: parsed.from.name,
          fromEmail: parsed.from.email,
          subject: parsed.subject,
          summary: classification.summary,
          draftText: draft,
          urgency: classification.urgency,
        })
      }
    }

    await upsertThread({
      externalId: parsed.threadId,
      domainId: classification.domain_id,
      topicId,
      from: parsed.from.email,
      to: parsed.to,
      receivedAt: parsed.receivedAt,
      summary: classification.summary,
    })

    return {
      messageId: parsed.id,
      status: 'ingested',
      classification,
      topicId,
      documentId: doc?.id,
      dropboxPaths,
      taskCreated,
    }
  } catch (err) {
    logger.error({ err, messageId: parsed.id }, 'ingestion failed')
    return {
      messageId: parsed.id,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function ensureTopic(
  domainId: string,
  hintId: string,
): Promise<string> {
  const existing = await db
    .select({ id: topics.id })
    .from(topics)
    .where(and(eq(topics.domainId, domainId), eq(topics.id, hintId)))
    .limit(1)
  if (existing.length > 0) return hintId

  const name = hintId
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

  await db.insert(topics).values({
    id: hintId,
    domainId,
    name,
    status: 'in_progress',
    priority: 'med',
  })

  logger.info({ topicId: hintId, domain: domainId, name }, 'topic created')
  return hintId
}

async function uploadAttachments(
  parsed: ParsedMessage,
  classification: Classification,
): Promise<string[]> {
  if (parsed.attachments.length === 0) return []

  const folder = `/${classification.domain_id ?? '_unsorted'}/${classification.sender_person_id ?? '_unknown'}`
  const datePrefix = parsed.receivedAt.toISOString().slice(0, 10)

  const gmail = makeGmailClient()
  const dbx = makeDropboxClient()
  const paths: string[] = []

  for (const att of parsed.attachments) {
    try {
      const buffer = await downloadAttachment(
        gmail,
        parsed.id,
        att.attachmentId,
      )
      const safeName = att.filename.replace(/[/\\]/g, '_')
      const saved = await uploadFile(
        dbx,
        `${folder}/${datePrefix} - ${safeName}`,
        buffer,
      )
      paths.push(saved)
      logger.info(
        { messageId: parsed.id, path: saved },
        'attachment uploaded',
      )
    } catch (err) {
      logger.error(
        { err, attachment: att.filename, messageId: parsed.id },
        'attachment upload failed',
      )
    }
  }

  return paths
}

async function upsertThread(input: {
  externalId: string
  domainId: string | null
  topicId: string | null
  from: string
  to: string[]
  receivedAt: Date
  summary: string
}): Promise<void> {
  const existing = await db
    .select({
      id: threads.id,
      domainId: threads.domainId,
      topicId: threads.topicId,
      participants: threads.participants,
    })
    .from(threads)
    .where(eq(threads.externalId, input.externalId))
    .limit(1)

  const prev = existing[0]
  const mergedParticipants = Array.from(
    new Set([input.from, ...input.to, ...(prev?.participants ?? [])]),
  )

  if (prev) {
    await db
      .update(threads)
      .set({
        domainId: input.domainId ?? prev.domainId,
        topicId: input.topicId ?? prev.topicId,
        participants: mergedParticipants,
        lastMessageAt: input.receivedAt,
        summary: input.summary,
        updatedAt: new Date(),
      })
      .where(eq(threads.id, prev.id))
  } else {
    await db.insert(threads).values({
      externalId: input.externalId,
      domainId: input.domainId,
      topicId: input.topicId,
      participants: mergedParticipants,
      status: 'open',
      lastMessageAt: input.receivedAt,
      summary: input.summary,
    })
  }
}
