import { and, eq } from 'drizzle-orm'
import { db } from '../integrations/postgres/db.js'
import {
  documents,
  persons,
  tasks,
  threads,
  topics,
} from '../integrations/postgres/schema.js'
import {
  downloadAttachment,
  makeGmailClient,
  type ParsedMessage,
} from '../integrations/gmail/client.js'
import { setFritzState, type FritzState } from '../integrations/gmail/labels.js'
import {
  makeDropboxClient,
  uploadFile,
} from '../integrations/dropbox/client.js'
import { classify, type Classification } from './classifier.js'
import { draftReply } from './drafter.js'
import { logger } from '../lib/logger.js'
import { notifyDraft, notifyForward, notifyFyi } from '../lib/notifier.js'
import {
  config,
  type ForwardingRule,
  type NotifyFyiRule,
} from '../lib/config.js'

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

    // Newsletter fast-path: List-Unsubscribe header is the de-facto marker
    // for bulk senders (RFC 8058). Skip the classifier completely and file
    // the mail as fyi/newsletter — saves an LLM call per newsletter.
    // Don't fast-path if the sender has attachments (could be a real invoice
    // from a vendor billing system that also includes List-Unsubscribe).
    if (parsed.hasListUnsubscribe && parsed.attachments.length === 0) {
      return await ingestNewsletterFastPath(parsed)
    }

    const classification = await classify({
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
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
          doc_type: classification.doc_type,
          suggested_action: classification.suggested_action,
          suggested_forward_to: classification.suggested_forward_to,
          attachments: dropboxPaths,
        },
      })
      .returning({ id: documents.id })

    let taskCreated = false
    let fritzState: FritzState = 'seen'
    const forwardRule = matchForwardingRule(classification)

    if (forwardRule && doc?.id) {
      const coverNote = buildForwardCoverNote(parsed, classification)
      const [task] = await db
        .insert(tasks)
        .values({
          topicId,
          relatedDocumentId: doc.id,
          kind: 'forward',
          forwardTo: forwardRule.forward_to,
          description: `Forward (${forwardRule.name}) → ${forwardRule.forward_to}: ${classification.summary}`,
          status: 'pending_user',
          requiresDecision: forwardRule.requires_approval,
          draftContent: coverNote,
        })
        .returning({ id: tasks.id })
      taskCreated = true
      fritzState = 'forward-pending'

      if (task?.id) {
        await notifyForward({
          taskId: task.id,
          fromName: parsed.from.name,
          fromEmail: parsed.from.email,
          subject: parsed.subject,
          summary: classification.summary,
          forwardTo: forwardRule.forward_to,
          ruleName: forwardRule.name,
          coverNote,
          attachments: parsed.attachments.map((a) => a.filename),
          urgency: classification.urgency,
          senderUnknown: classification.sender_person_id === null,
        })
      }
    } else if (classification.intent === 'action_required' && doc?.id) {
      // Cost optimization: only auto-draft when the sender is in our persons DB.
      // For unknown senders, create a draftless task — user taps [📝 Draft]
      // on the Telegram card if they actually want a reply generated.
      // Saves Sonnet calls on misclassified spam / cold outreach.
      const senderKnown = classification.sender_person_id !== null

      let draft: string | null = null
      if (senderKnown) {
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
      }

      const [task] = await db
        .insert(tasks)
        .values({
          topicId,
          relatedDocumentId: doc.id,
          kind: 'reply',
          description: classification.summary,
          status: 'pending_user',
          requiresDecision: true,
          draftContent: draft,
        })
        .returning({ id: tasks.id })
      taskCreated = true
      fritzState = 'draft-pending'

      if (task?.id) {
        await notifyDraft({
          taskId: task.id,
          fromName: parsed.from.name,
          fromEmail: parsed.from.email,
          subject: parsed.subject,
          summary: classification.summary,
          draftText: draft ?? '',
          urgency: classification.urgency,
          senderUnknown: !senderKnown,
        })
      }
    } else if (doc?.id) {
      // Neither forward nor reply — check notify_fyi rules.
      const senderRole = await resolveSenderRole(classification.sender_person_id)
      const fyiMatch = matchNotifyFyiRule(classification, senderRole)
      if (fyiMatch) {
        const [task] = await db
          .insert(tasks)
          .values({
            topicId,
            relatedDocumentId: doc.id,
            kind: 'fyi_notify',
            description: `FYI (${fyiMatch.reason ?? 'wichtig'}): ${classification.summary}`,
            status: 'pending_user',
            requiresDecision: false,
            draftContent: null,
          })
          .returning({ id: tasks.id })
        taskCreated = true
        fritzState = 'seen'

        if (task?.id) {
          await notifyFyi({
            taskId: task.id,
            fromName: parsed.from.name,
            fromEmail: parsed.from.email,
            subject: parsed.subject,
            summary: classification.summary,
            urgency: classification.urgency,
            reason: fyiMatch.reason ?? 'wichtig',
            senderUnknown: classification.sender_person_id === null,
          })
        }
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

    // Best-effort Gmail label so Thomas sees Fritz' state in the inbox.
    // Errors are caught inside setFritzState and never propagate up.
    const labelGmail = makeGmailClient()
    void setFritzState(labelGmail, parsed.id, fritzState)

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

/**
 * Heuristic-only ingestion for newsletters: no LLM call, no draft, no notify.
 * The classifier was burning ~85% of its calls on mails that are clearly bulk
 * (List-Unsubscribe header present). This path files them as fyi/newsletter
 * and labels them Fritz/seen so they're still inventoried.
 */
async function ingestNewsletterFastPath(
  parsed: ParsedMessage,
): Promise<IngestionResult> {
  const summary = parsed.subject
  const [doc] = await db
    .insert(documents)
    .values({
      source: 'gmail',
      sourceId: parsed.id,
      receivedAt: parsed.receivedAt,
      summary,
      originalSubject: parsed.subject,
      metadata: {
        from_email: parsed.from.email,
        from_name: parsed.from.name ?? null,
        thread_id: parsed.threadId,
        intent: 'fyi',
        urgency: 'low',
        language: null,
        doc_type: 'newsletter',
        suggested_action: 'none',
        suggested_forward_to: null,
        attachments: [],
        fast_path: 'newsletter_list_unsubscribe',
      },
    })
    .returning({ id: documents.id })

  await upsertThread({
    externalId: parsed.threadId,
    domainId: null,
    topicId: null,
    from: parsed.from.email,
    to: parsed.to,
    receivedAt: parsed.receivedAt,
    summary,
  })

  // Label the mail in Gmail so it's still visible as "seen by Fritz"
  const gmail = makeGmailClient()
  void setFritzState(gmail, parsed.id, 'seen')

  logger.info(
    { messageId: parsed.id, from: parsed.from.email },
    'newsletter fast-path (no LLM call)',
  )

  return {
    messageId: parsed.id,
    status: 'ingested',
    documentId: doc?.id,
    dropboxPaths: [],
    taskCreated: false,
  }
}

async function resolveSenderRole(
  senderPersonId: string | null,
): Promise<string | null> {
  if (!senderPersonId) return null
  const [p] = await db
    .select({ role: persons.role })
    .from(persons)
    .where(eq(persons.id, senderPersonId))
    .limit(1)
  return p?.role ?? null
}

function matchNotifyFyiRule(
  c: Classification,
  senderRole: string | null,
): NotifyFyiRule | null {
  for (const rule of config.policies.notify_fyi) {
    if (rule.when_doc_type_in && c.doc_type) {
      if (rule.when_doc_type_in.includes(c.doc_type)) return rule
    }
    if (rule.when_sender_role_in && senderRole) {
      // Match by role substring after "service_provider:" prefix, or exact.
      const normalized = senderRole.split(':').pop() ?? senderRole
      if (rule.when_sender_role_in.includes(normalized)) return rule
    }
    if (rule.when_urgency && rule.when_urgency === c.urgency) return rule
  }
  return null
}

/**
 * Match the classifier's suggestion against the configured forwarding_rules.
 * The LLM's `suggested_forward_to` is validated against the rule's target so a
 * hallucinated address can't leak out — the rule is the source of truth.
 */
function matchForwardingRule(c: Classification): ForwardingRule | null {
  if (c.suggested_action !== 'forward' || !c.doc_type) return null
  const rule = config.policies.forwarding_rules.find(
    (r) => r.doc_type === c.doc_type,
  )
  if (!rule) return null
  if (
    c.suggested_forward_to &&
    c.suggested_forward_to.toLowerCase() !== rule.forward_to.toLowerCase()
  ) {
    logger.warn(
      {
        suggested: c.suggested_forward_to,
        policy: rule.forward_to,
        doc_type: c.doc_type,
      },
      'classifier suggested forward_to does not match policy — using policy target',
    )
  }
  return rule
}

function buildForwardCoverNote(
  parsed: ParsedMessage,
  c: Classification,
): string {
  const senderLabel = parsed.from.name
    ? `${parsed.from.name} <${parsed.from.email}>`
    : parsed.from.email
  return (
    `FYI — automatisch weitergeleitet von Fritz.\n\n` +
    `Absender: ${senderLabel}\n` +
    `Betreff:  ${parsed.subject}\n` +
    `Kurz:     ${c.summary}\n`
  )
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
