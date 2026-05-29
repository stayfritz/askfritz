import type { Bot } from 'grammy'
import { desc, eq } from 'drizzle-orm'
import { db } from '../integrations/postgres/db.js'
import {
  documents,
  tasks,
  topics,
} from '../integrations/postgres/schema.js'
import { answerQuery } from './query.js'
import { draftReply } from './drafter.js'
import { notifyDraft } from '../lib/notifier.js'
import {
  fetchMessage,
  makeGmailClient,
  parseMessage,
  sendReply,
} from '../integrations/gmail/client.js'
import { logger } from '../lib/logger.js'

/**
 * In-memory state: which task is the user currently editing?
 * Keyed by Telegram user id. Lost on restart (acceptable for v0).
 */
const pendingEdits = new Map<number, string>()

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
