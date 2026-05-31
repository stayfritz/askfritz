import type { Bot } from 'grammy'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../integrations/postgres/db.js'
import {
  documents,
  tasks,
  topics,
} from '../integrations/postgres/schema.js'
import { answerQuery } from './query.js'
import { draftReply } from './drafter.js'
import { ingestMessage } from './ingestion.js'
import { notifyDraft } from '../lib/notifier.js'
import { resetConversation } from '../lib/conversation-store.js'
import {
  downloadAttachment,
  fetchMessage,
  forwardMessage,
  makeGmailClient,
  parseMessage,
  sendReply,
} from '../integrations/gmail/client.js'
import {
  createEvent,
  makeCalendarClient,
} from '../integrations/calendar/client.js'
import { logger } from '../lib/logger.js'

/**
 * In-memory state: which task is the user currently editing?
 * Keyed by Telegram user id. Lost on restart (acceptable for v0).
 */
const pendingEdits = new Map<number, string>()

/** Forward-task awaiting a new recipient address from the user. */
const pendingRecipientEdits = new Map<number, string>()

export function registerTelegramHandlers(
  bot: Bot,
  allowedUserId: number,
): void {
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== allowedUserId) {
      logger.warn(
        { fromId: ctx.from?.id, username: ctx.from?.username },
        'unauthorized telegram message ignored',
      )
      return
    }
    await next()
  })

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Hi Thomas — ich bin Fritz, dein Stabschef.\n\n' +
        'Wenn eine Mail eine Antwort braucht, schick ich dir einen Entwurf mit Buttons (Senden / Bearbeiten / Verwerfen).\n\n' +
        'Du kannst mich aber auch jederzeit fragen, z.B.:\n' +
        '• „Was muss ich Kerstin antworten?"\n' +
        '• „Was steht beim Stb gerade an?"\n\n' +
        'Commands:\n' +
        '/status — pending Tasks + offene Topics\n' +
        '/topics — alle offenen Vorgänge\n' +
        '/help — dieser Text',
    )
  })

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Stell mir Fragen zu deinen Vorgängen, oder warte auf Mail-Entwürfe.\n\n' +
        '/status — pending Tasks + Übersicht\n' +
        '/topics — alle offenen Topics\n' +
        '/help — dieser Text',
    )
  })

  bot.command('status', async (ctx) => {
    const [pendingTasks, openTopics] = await Promise.all([
      db
        .select()
        .from(tasks)
        .where(eq(tasks.status, 'pending_user'))
        .orderBy(desc(tasks.createdAt))
        .limit(10),
      db
        .select()
        .from(topics)
        .where(eq(topics.status, 'in_progress')),
    ])

    if (pendingTasks.length === 0 && openTopics.length === 0) {
      await ctx.reply(
        'Alles im grünen Bereich. Keine pending Tasks, keine offenen Topics.',
      )
      return
    }

    const tasksList = pendingTasks
      .slice(0, 5)
      .map((t, i) => {
        const desc = t.description ?? ''
        const trimmed = desc.length > 250 ? desc.slice(0, 250) + '…' : desc
        return `${i + 1}. ${trimmed}`
      })
      .join('\n\n')

    await ctx.reply(
      `📊 Stand:\n\n` +
        `📋 ${pendingTasks.length} Tasks pending • ${openTopics.length} offene Topics\n\n` +
        (tasksList ? `Top Tasks:\n\n${tasksList}` : '(keine Tasks)'),
    )
  })

  bot.command('reset', async (ctx) => {
    resetConversation(ctx.from!.id)
    await ctx.reply(
      '🧹 Konversations-Verlauf gelöscht. Nächste Nachricht startet frisch.',
    )
  })

  bot.command('topics', async (ctx) => {
    const openTopics = await db
      .select()
      .from(topics)
      .where(eq(topics.status, 'in_progress'))
      .orderBy(desc(topics.updatedAt))

    if (openTopics.length === 0) {
      await ctx.reply('Keine offenen Topics.')
      return
    }

    const list = openTopics
      .map((t, i) => `${i + 1}. ${t.name} (priority: ${t.priority})`)
      .join('\n')
    await ctx.reply(`Offene Topics (${openTopics.length}):\n\n${list}`)
  })

  bot.command('reingest', async (ctx) => {
    const arg = ctx.match?.trim()
    if (!arg) {
      await ctx.reply(
        'Usage: /reingest <gmail_message_id>\n\nLöscht das alte Document + pending Tasks und re-klassifiziert die Mail mit dem aktuellen Classifier. Nutze das, wenn der Classifier eine Mail falsch eingeordnet hat.',
      )
      return
    }
    await ctx.api.sendChatAction(ctx.chat.id, 'typing')
    try {
      const summary = await handleReingest(arg)
      await ctx.reply(summary)
    } catch (err) {
      logger.error({ err, messageId: arg }, 're-ingest failed')
      await ctx.reply(
        `⚠️ Re-ingest fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    if (!taskId) {
      await ctx.answerCallbackQuery('Task-ID fehlt')
      return
    }
    try {
      await handleApprove(taskId)
      await ctx.answerCallbackQuery('Gesendet ✅')
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })
      await ctx.reply('Mail ist raus, Task auf done gesetzt.')
    } catch (err) {
      logger.error({ err, taskId }, 'approve failed')
      await ctx.answerCallbackQuery('Fehler')
      await ctx.reply(
        `⚠️ Senden fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    if (!taskId) {
      await ctx.answerCallbackQuery('Task-ID fehlt')
      return
    }
    pendingEdits.set(ctx.from!.id, taskId)
    await ctx.answerCallbackQuery()
    await ctx.reply(
      'Was soll ich ändern? Schreib mir deine Änderungswünsche in einer Nachricht — ich generiere den Entwurf neu.',
    )
  })

  bot.callbackQuery(/^cal_create:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    if (!taskId) {
      await ctx.answerCallbackQuery('Task-ID fehlt')
      return
    }
    try {
      const summary = await handleCalendarCreate(taskId)
      await ctx.answerCallbackQuery('Eingetragen ✅')
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })
      await ctx.reply(`Termin "${summary}" ist im Kalender. Task auf done.`)
    } catch (err) {
      logger.error({ err, taskId }, 'calendar create failed')
      await ctx.answerCallbackQuery('Fehler')
      await ctx.reply(
        `⚠️ Termin eintragen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  bot.callbackQuery(/^cal_edit:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    if (!taskId) {
      await ctx.answerCallbackQuery('Task-ID fehlt')
      return
    }
    await ctx.answerCallbackQuery()
    await ctx.reply(
      'Was soll ich am Termin ändern? Schreib mir deine Anpassung als normale Nachricht — ich nutze sie als neue Anweisung an Fritz (z.B. "verschiebe auf 16 Uhr" oder "ohne Anke einladen").',
    )
  })

  bot.callbackQuery(/^forward:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    if (!taskId) {
      await ctx.answerCallbackQuery('Task-ID fehlt')
      return
    }
    try {
      const target = await handleForward(taskId)
      await ctx.answerCallbackQuery('Weitergeleitet ✅')
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })
      await ctx.reply(`Mail an ${target} weitergeleitet, Task auf done.`)
    } catch (err) {
      logger.error({ err, taskId }, 'forward failed')
      await ctx.answerCallbackQuery('Fehler')
      await ctx.reply(
        `⚠️ Weiterleiten fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  bot.callbackQuery(/^fwd_edit:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    if (!taskId) {
      await ctx.answerCallbackQuery('Task-ID fehlt')
      return
    }
    pendingRecipientEdits.set(ctx.from!.id, taskId)
    await ctx.answerCallbackQuery()
    await ctx.reply(
      'An welche Adresse soll ich weiterleiten? Schick mir die Email-Adresse in einer Nachricht.',
    )
  })

  bot.callbackQuery(/^discard:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    if (!taskId) {
      await ctx.answerCallbackQuery('Task-ID fehlt')
      return
    }
    await db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
    await ctx.answerCallbackQuery('Verworfen 🗑')
    await ctx.editMessageReplyMarkup({ reply_markup: undefined })
    await ctx.reply('Entwurf verworfen, Task auf cancelled.')
  })

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    if (text.startsWith('/')) return

    // Are we waiting for a new forward recipient from this user?
    const recipientTaskId = pendingRecipientEdits.get(ctx.from!.id)
    if (recipientTaskId) {
      pendingRecipientEdits.delete(ctx.from!.id)
      const newAddr = text.trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newAddr)) {
        await ctx.reply('Das sieht nicht nach einer gültigen Email-Adresse aus. Versuch nochmal über den Button.')
        return
      }
      await db
        .update(tasks)
        .set({ forwardTo: newAddr, updatedAt: new Date() })
        .where(eq(tasks.id, recipientTaskId))
      await ctx.reply(`OK, Empfänger geändert auf ${newAddr}. Nutze den ✅-Button in der ursprünglichen Nachricht zum Senden, oder /status für die Übersicht.`)
      return
    }

    // Are we waiting for edit instructions from this user?
    const editingTaskId = pendingEdits.get(ctx.from!.id)
    if (editingTaskId) {
      pendingEdits.delete(ctx.from!.id)
      await ctx.api.sendChatAction(ctx.chat.id, 'typing')
      try {
        await handleEditWithInstructions(editingTaskId, text)
      } catch (err) {
        logger.error({ err, taskId: editingTaskId }, 'edit failed')
        await ctx.reply(
          `⚠️ Neu-Generieren fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return
    }

    logger.info(
      { fromId: ctx.from?.id, text: text.slice(0, 200) },
      'telegram query received',
    )

    await ctx.api.sendChatAction(ctx.chat.id, 'typing')
    try {
      const answer = await answerQuery(text, { userId: ctx.from!.id })
      await ctx.reply(answer)
    } catch (err) {
      logger.error({ err }, 'query failed')
      await ctx.reply(
        '⚠️ Da ist was schiefgelaufen — schau in die Server-Logs.',
      )
    }
  })

  bot.catch((err) => {
    logger.error({ err: err.error }, 'telegram bot error')
  })
}

async function handleApprove(taskId: string): Promise<void> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (!task) throw new Error('task not found')
  if (!task.draftContent) throw new Error('no draft on task')
  if (!task.relatedDocumentId)
    throw new Error('no related document — cannot reply')

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, task.relatedDocumentId))
    .limit(1)
  if (!doc) throw new Error('related document not found')
  if (doc.source !== 'gmail' || !doc.sourceId)
    throw new Error('document is not a gmail message')

  const gmail = makeGmailClient()
  const raw = await fetchMessage(gmail, doc.sourceId)
  const parsed = parseMessage(raw)

  if (!parsed.messageIdHeader) {
    throw new Error('original message has no Message-ID header')
  }

  const subject = parsed.subject.startsWith('Re:')
    ? parsed.subject
    : `Re: ${parsed.subject}`

  const sentId = await sendReply(gmail, {
    to: parsed.from.email,
    subject,
    body: task.draftContent,
    inReplyTo: parsed.messageIdHeader,
    references: parsed.referencesHeader,
    threadId: parsed.threadId,
  })

  await db
    .update(tasks)
    .set({ status: 'done', updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  logger.info(
    { taskId, sentMessageId: sentId, to: parsed.from.email },
    'reply sent',
  )
}

async function handleReingest(messageId: string): Promise<string> {
  // 1. Delete existing document + pending tasks for this message
  const existing = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(eq(documents.source, 'gmail'), eq(documents.sourceId, messageId)),
    )

  let deletedTasks = 0
  for (const doc of existing) {
    const dt = await db
      .delete(tasks)
      .where(
        and(
          eq(tasks.relatedDocumentId, doc.id),
          eq(tasks.status, 'pending_user'),
        ),
      )
      .returning({ id: tasks.id })
    deletedTasks += dt.length
    await db.delete(documents).where(eq(documents.id, doc.id))
  }

  // 2. Fetch + parse + re-ingest with current code
  const gmail = makeGmailClient()
  const raw = await fetchMessage(gmail, messageId)
  const parsed = parseMessage(raw)
  const result = await ingestMessage(parsed)

  const lines: string[] = []
  lines.push(`🔄 Re-ingest "${parsed.subject}"`)
  lines.push(
    `Aufgeräumt: ${existing.length} Document(s), ${deletedTasks} pending Task(s).`,
  )
  lines.push(`Status: ${result.status}`)
  if (result.status === 'ingested' && result.classification) {
    const c = result.classification
    lines.push(
      `Classifier: intent=${c.intent}, doc_type=${c.doc_type ?? '—'}, action=${c.suggested_action}` +
        (c.suggested_forward_to ? ` → ${c.suggested_forward_to}` : ''),
    )
    if (result.taskCreated) {
      lines.push('✅ Task erzeugt — die Karte kommt gleich.')
    } else {
      lines.push(
        'ℹ️ Kein Task erzeugt (kein Forward-Match, kein action_required).',
      )
    }
  } else if (result.status === 'failed') {
    lines.push(`Fehler: ${result.error}`)
  }
  return lines.join('\n')
}

async function handleCalendarCreate(taskId: string): Promise<string> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (!task) throw new Error('task not found')
  if (task.kind !== 'calendar_event')
    throw new Error('task is not a calendar event')
  const payload = task.calendarPayload
  if (!payload) throw new Error('no calendar_payload on task')

  const cal = makeCalendarClient()
  const event = await createEvent(cal, {
    summary: payload.summary,
    ...(payload.description ? { description: payload.description } : {}),
    startIso: payload.start_iso,
    endIso: payload.end_iso,
    timezone: payload.timezone,
    ...(payload.attendees ? { attendees: payload.attendees } : {}),
    ...(payload.location ? { location: payload.location } : {}),
    sendInvites: payload.send_invites ?? false,
  })

  await db
    .update(tasks)
    .set({ status: 'done', updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  logger.info(
    { taskId, eventId: event.id, htmlLink: event.htmlLink },
    'calendar event created',
  )
  return event.summary
}

async function handleForward(taskId: string): Promise<string> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (!task) throw new Error('task not found')
  if (task.kind !== 'forward') throw new Error('task is not a forward')
  if (!task.forwardTo) throw new Error('task has no forward_to recipient')
  if (!task.relatedDocumentId)
    throw new Error('no related document — cannot forward')

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, task.relatedDocumentId))
    .limit(1)
  if (!doc) throw new Error('related document not found')
  if (doc.source !== 'gmail' || !doc.sourceId)
    throw new Error('document is not a gmail message')

  const gmail = makeGmailClient()
  const raw = await fetchMessage(gmail, doc.sourceId)
  const parsed = parseMessage(raw)

  const attachments: Array<{
    filename: string
    mimeType: string
    data: Buffer
  }> = []
  for (const att of parsed.attachments) {
    const buf = await downloadAttachment(gmail, doc.sourceId, att.attachmentId)
    attachments.push({ filename: att.filename, mimeType: att.mimeType, data: buf })
  }

  const sentId = await forwardMessage(gmail, {
    to: task.forwardTo,
    subject: parsed.subject,
    coverNote: task.draftContent ?? undefined,
    original: {
      from: parsed.from.name
        ? `${parsed.from.name} <${parsed.from.email}>`
        : parsed.from.email,
      date: parsed.receivedAt,
      subject: parsed.subject,
      to: parsed.to,
      bodyText: parsed.bodyText,
    },
    attachments,
  })

  await db
    .update(tasks)
    .set({ status: 'done', updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  logger.info(
    { taskId, sentMessageId: sentId, to: task.forwardTo, attachments: attachments.length },
    'forwarded',
  )
  return task.forwardTo
}

async function handleEditWithInstructions(
  taskId: string,
  instructions: string,
): Promise<void> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (!task) throw new Error('task not found')
  if (!task.relatedDocumentId)
    throw new Error('no related document on task')

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, task.relatedDocumentId))
    .limit(1)
  if (!doc || doc.source !== 'gmail' || !doc.sourceId) {
    throw new Error('related document missing or non-gmail')
  }

  const gmail = makeGmailClient()
  const raw = await fetchMessage(gmail, doc.sourceId)
  const parsed = parseMessage(raw)

  const meta = (doc.metadata as Record<string, unknown>) ?? {}
  const language =
    typeof meta.language === 'string' ? meta.language : 'de'

  const newDraft = await draftReply({
    originalFrom: parsed.from,
    originalSubject: parsed.subject,
    originalBody: parsed.bodyText,
    language,
    summary: doc.summary ?? '',
    editInstructions: instructions,
    previousDraft: task.draftContent ?? undefined,
  })

  await db
    .update(tasks)
    .set({ draftContent: newDraft, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  const urgencyRaw = meta.urgency
  const urgency: 'low' | 'med' | 'high' =
    urgencyRaw === 'high' || urgencyRaw === 'low' ? urgencyRaw : 'med'

  await notifyDraft({
    taskId,
    fromName: parsed.from.name,
    fromEmail: parsed.from.email,
    subject: parsed.subject,
    summary: doc.summary ?? '',
    draftText: newDraft,
    urgency,
  })
}
