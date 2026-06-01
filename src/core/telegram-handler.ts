import type { Bot } from 'grammy'
import { and, desc, eq } from 'drizzle-orm'
import { InlineKeyboard } from 'grammy'
import { db } from '../integrations/postgres/db.js'
import {
  documents,
  persons,
  tasks,
  topics,
} from '../integrations/postgres/schema.js'
import { config } from '../lib/config.js'
import { answerQuery } from './query.js'
import { draftReply } from './drafter.js'
import { ingestMessage } from './ingestion.js'
import { notifyDraft, notifyExtended } from '../lib/notifier.js'
import { resetConversation } from '../lib/conversation-store.js'
import {
  downloadAttachment,
  fetchMessage,
  forwardMessage,
  makeGmailClient,
  parseMessage,
  sendReply,
} from '../integrations/gmail/client.js'
import { setFritzState, type FritzState } from '../integrations/gmail/labels.js'
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

/** In-flight person classification, keyed by Telegram user id. */
interface PendingPersonClassify {
  fromEmail: string
  fromName: string | null
  role?: string
}
const pendingPersonClassify = new Map<number, PendingPersonClassify>()

const ROLE_CHOICES: Array<{ label: string; value: string }> = [
  { label: 'Banker', value: 'banker' },
  { label: 'Stb', value: 'tax_advisor' },
  { label: 'Versicherung', value: 'insurance_admin' },
  { label: 'Anwalt', value: 'lawyer' },
  { label: 'Familie', value: 'family' },
  { label: 'Freund', value: 'friend' },
  { label: 'Geschäft', value: 'business' },
  { label: 'Andere…', value: '__other__' },
]

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
    await labelTaskMessage(taskId, 'discarded')
    await ctx.answerCallbackQuery('Verworfen 🗑')
    await ctx.editMessageReplyMarkup({ reply_markup: undefined })
  })

  bot.callbackQuery(/^done:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    if (!taskId) {
      await ctx.answerCallbackQuery('Task-ID fehlt')
      return
    }
    await db
      .update(tasks)
      .set({ status: 'done', updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
    await labelTaskMessage(taskId, 'seen')
    await ctx.answerCallbackQuery('Erledigt ✓')
    await ctx.editMessageReplyMarkup({ reply_markup: undefined })
  })

  bot.callbackQuery(/^gen_draft:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    if (!taskId) {
      await ctx.answerCallbackQuery('Task-ID fehlt')
      return
    }
    try {
      await ctx.answerCallbackQuery('Erstelle Draft…')
      await handleGenerateDraft(taskId)
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })
    } catch (err) {
      logger.error({ err, taskId }, 'gen_draft failed')
      await ctx.reply(
        `⚠️ Draft-Generierung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  bot.callbackQuery(/^person_add:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    if (!taskId) {
      await ctx.answerCallbackQuery('Task-ID fehlt')
      return
    }
    try {
      const sender = await getSenderForTask(taskId)
      if (!sender) {
        await ctx.answerCallbackQuery('Kein Sender gefunden')
        return
      }
      pendingPersonClassify.set(ctx.from!.id, {
        fromEmail: sender.email,
        fromName: sender.name,
      })
      const kb = new InlineKeyboard()
      // 2 per row
      for (let i = 0; i < ROLE_CHOICES.length; i += 2) {
        const a = ROLE_CHOICES[i]
        const b = ROLE_CHOICES[i + 1]
        if (a) kb.text(a.label, `pcls_role:${a.value}`)
        if (b) kb.text(b.label, `pcls_role:${b.value}`)
        kb.row()
      }
      await ctx.answerCallbackQuery()
      await ctx.reply(
        `Welche Rolle hat ${sender.name ?? sender.email}?`,
        { reply_markup: kb },
      )
    } catch (err) {
      logger.error({ err, taskId }, 'person_add failed')
      await ctx.answerCallbackQuery('Fehler')
    }
  })

  bot.callbackQuery(/^pcls_role:(.+)$/, async (ctx) => {
    const role = ctx.match[1]
    if (!role) {
      await ctx.answerCallbackQuery('Rolle fehlt')
      return
    }
    const pending = pendingPersonClassify.get(ctx.from!.id)
    if (!pending) {
      await ctx.answerCallbackQuery('Keine Auswahl in flight')
      await ctx.reply(
        'Hmm, ich weiß nicht mehr welchen Sender du klassifizieren wolltest. Tipp den `👤 Sender anlegen`-Button nochmal an.',
      )
      return
    }
    if (role === '__other__') {
      await ctx.answerCallbackQuery()
      await ctx.reply(
        'OK — schreib mir die Rolle als kurze snake_case-Bezeichnung (z.B. "vermieter", "arzt", "buchhalter").',
      )
      pending.role = '__pending_text__'
      pendingPersonClassify.set(ctx.from!.id, pending)
      return
    }
    pending.role = role
    pendingPersonClassify.set(ctx.from!.id, pending)
    await ctx.answerCallbackQuery()
    await askDomainStep(ctx)
  })

  bot.callbackQuery(/^pcls_dom:(.+)$/, async (ctx) => {
    const domainId = ctx.match[1]
    if (!domainId) {
      await ctx.answerCallbackQuery('Domain fehlt')
      return
    }
    const pending = pendingPersonClassify.get(ctx.from!.id)
    if (!pending || !pending.role) {
      await ctx.answerCallbackQuery('Keine Auswahl in flight')
      return
    }
    try {
      const personId = await upsertPersonFromInline({
        domainId,
        role: pending.role,
        fromEmail: pending.fromEmail,
        fromName: pending.fromName,
      })
      pendingPersonClassify.delete(ctx.from!.id)
      await ctx.answerCallbackQuery('Angelegt ✓')
      await ctx.reply(
        `Person ${personId} angelegt: ${pending.fromName ?? pending.fromEmail} (${pending.role}) in Domain ${domainId}. Zukünftige Mails matchen automatisch.`,
      )
    } catch (err) {
      logger.error({ err }, 'person classify failed')
      await ctx.answerCallbackQuery('Fehler')
      await ctx.reply(
        `⚠️ Anlegen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  bot.callbackQuery(/^extend:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    if (!taskId) {
      await ctx.answerCallbackQuery('Task-ID fehlt')
      return
    }
    try {
      await handleExtend(taskId)
      await ctx.answerCallbackQuery()
    } catch (err) {
      logger.error({ err, taskId }, 'extend failed')
      await ctx.answerCallbackQuery('Fehler')
      await ctx.reply(
        `⚠️ Mehr-Details-Anzeige fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    if (text.startsWith('/')) return

    // Are we waiting for a free-text role for person classification?
    const pendingPerson = pendingPersonClassify.get(ctx.from!.id)
    if (pendingPerson && pendingPerson.role === '__pending_text__') {
      const role = text.trim().toLowerCase().replace(/\s+/g, '_')
      if (!/^[a-z0-9_]+$/.test(role) || role.length < 2) {
        await ctx.reply('Sieht ungültig aus. Nur Kleinbuchstaben/Ziffern/Unterstrich, z.B. "vermieter".')
        return
      }
      pendingPerson.role = role
      pendingPersonClassify.set(ctx.from!.id, pendingPerson)
      await askDomainStep(ctx)
      return
    }

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

/**
 * Look up the Gmail message_id behind a task and label it with the given
 * Fritz state. Best-effort: silent no-op if the task has no related document
 * or the document isn't a Gmail message (e.g. standalone calendar events).
 */
async function labelTaskMessage(
  taskId: string,
  state: FritzState,
): Promise<void> {
  try {
    const [task] = await db
      .select({ relatedDocumentId: tasks.relatedDocumentId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    if (!task?.relatedDocumentId) return
    const [doc] = await db
      .select({ source: documents.source, sourceId: documents.sourceId })
      .from(documents)
      .where(eq(documents.id, task.relatedDocumentId))
      .limit(1)
    if (!doc || doc.source !== 'gmail' || !doc.sourceId) return
    const gmail = makeGmailClient()
    await setFritzState(gmail, doc.sourceId, state)
  } catch (err) {
    logger.error({ err, taskId, state }, 'labelTaskMessage failed')
  }
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

  await setFritzState(gmail, doc.sourceId, 'replied')

  logger.info(
    { taskId, sentMessageId: sentId, to: parsed.from.email },
    'reply sent',
  )
}

async function getSenderForTask(
  taskId: string,
): Promise<{ email: string; name: string | null } | null> {
  const [task] = await db
    .select({ relatedDocumentId: tasks.relatedDocumentId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (!task?.relatedDocumentId) return null
  const [doc] = await db
    .select({ metadata: documents.metadata })
    .from(documents)
    .where(eq(documents.id, task.relatedDocumentId))
    .limit(1)
  if (!doc) return null
  const meta = (doc.metadata as Record<string, unknown>) ?? {}
  const email = typeof meta.from_email === 'string' ? meta.from_email : null
  const name = typeof meta.from_name === 'string' ? meta.from_name : null
  if (!email) return null
  return { email, name }
}

function buildDomainKeyboard(): InlineKeyboard {
  const domains = config.domains.domains
  const kb = new InlineKeyboard()
  for (let i = 0; i < domains.length; i += 2) {
    const a = domains[i]
    const b = domains[i + 1]
    if (a) kb.text(a.name, `pcls_dom:${a.id}`)
    if (b) kb.text(b.name, `pcls_dom:${b.id}`)
    kb.row()
  }
  return kb
}

async function askDomainStep(
  ctx: { reply: (text: string, opts: { reply_markup: InlineKeyboard }) => Promise<unknown> },
): Promise<void> {
  await ctx.reply('In welchen Lebensbereich gehört diese Person?', {
    reply_markup: buildDomainKeyboard(),
  })
}

async function upsertPersonFromInline(input: {
  domainId: string
  role: string
  fromEmail: string
  fromName: string | null
}): Promise<string> {
  // Try to find existing person by email match
  const all = await db.select().from(persons)
  const existing = all.find((p) =>
    p.emails?.some((e) => e.toLowerCase() === input.fromEmail.toLowerCase()),
  )
  if (existing) {
    await db
      .update(persons)
      .set({
        role: input.role,
        domainId: input.domainId,
        updatedAt: new Date(),
      })
      .where(eq(persons.id, existing.id))
    return existing.id
  }

  // Derive a snake_case id from name or email-local
  const base = (
    input.fromName ?? input.fromEmail.split('@')[0] ?? 'unknown'
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  let id = base || 'person'
  // Disambiguate if id collides
  let suffix = 2
  while (all.some((p) => p.id === id)) {
    id = `${base}_${suffix++}`
  }

  await db.insert(persons).values({
    id,
    domainId: input.domainId,
    name: input.fromName ?? input.fromEmail,
    role: input.role,
    emails: [input.fromEmail],
    phones: [],
  })
  return id
}

async function handleGenerateDraft(taskId: string): Promise<void> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (!task) throw new Error('task not found')
  if (task.kind !== 'reply')
    throw new Error('only reply tasks support gen_draft')
  if (!task.relatedDocumentId)
    throw new Error('no related document — cannot draft')

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, task.relatedDocumentId))
    .limit(1)
  if (!doc || doc.source !== 'gmail' || !doc.sourceId)
    throw new Error('related document missing or non-gmail')

  const gmail = makeGmailClient()
  const raw = await fetchMessage(gmail, doc.sourceId)
  const parsed = parseMessage(raw)
  const meta = (doc.metadata as Record<string, unknown>) ?? {}
  const language = typeof meta.language === 'string' ? meta.language : 'de'

  const draft = await draftReply({
    originalFrom: parsed.from,
    originalSubject: parsed.subject,
    originalBody: parsed.bodyText,
    language,
    summary: doc.summary ?? '',
  })

  await db
    .update(tasks)
    .set({ draftContent: draft, updatedAt: new Date() })
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
    draftText: draft,
    urgency,
    senderUnknown: false,
  })
  logger.info({ taskId }, 'draft generated on-demand')
}

async function handleExtend(taskId: string): Promise<void> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (!task) throw new Error('task not found')

  if (task.kind === 'calendar_event') {
    const p = task.calendarPayload
    if (!p) {
      await notifyExtended({
        taskKind: 'calendar_event',
        body: '(kein Payload)',
      })
      return
    }
    const lines = [
      `Titel: ${p.summary}`,
      `Start: ${p.start_iso}`,
      `Ende:  ${p.end_iso}`,
      `Zeitzone: ${p.timezone}`,
      p.location ? `Ort: ${p.location}` : null,
      p.attendees && p.attendees.length
        ? `Teilnehmer:\n${p.attendees.map((a) => `  • ${a}`).join('\n')}`
        : null,
      p.send_invites ? '📧 Einladungs-Mails werden gesendet.' : '📭 Keine Einladungs-Mails.',
      p.description ? `\nBeschreibung:\n${p.description}` : null,
    ].filter(Boolean)
    await notifyExtended({
      taskKind: 'calendar_event',
      body: lines.join('\n'),
    })
    return
  }

  if (!task.relatedDocumentId) {
    await notifyExtended({
      taskKind: task.kind === 'forward' ? 'forward' : 'reply',
      body: task.draftContent ?? '(kein Inhalt)',
    })
    return
  }

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, task.relatedDocumentId))
    .limit(1)

  const fromEmail =
    typeof (doc?.metadata as Record<string, unknown>)?.from_email === 'string'
      ? ((doc?.metadata as Record<string, unknown>).from_email as string)
      : undefined

  if (task.kind === 'forward') {
    await notifyExtended({
      taskKind: 'forward',
      from: fromEmail,
      to: task.forwardTo ?? undefined,
      subject: doc?.originalSubject ?? undefined,
      body: task.draftContent ?? '(kein Cover-Text)',
    })
    return
  }

  // reply
  await notifyExtended({
    taskKind: 'reply',
    from: fromEmail,
    subject: doc?.originalSubject ?? undefined,
    body: task.draftContent ?? '(kein Entwurf)',
  })
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

  await setFritzState(gmail, doc.sourceId, 'forwarded')

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
