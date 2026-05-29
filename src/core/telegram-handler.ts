import type { Bot } from 'grammy'
import { desc, eq } from 'drizzle-orm'
import { db } from '../integrations/postgres/db.js'
import { tasks, topics } from '../integrations/postgres/schema.js'
import { answerQuery } from './query.js'
import { logger } from '../lib/logger.js'

export function registerTelegramHandlers(
  bot: Bot,
  allowedUserId: number,
): void {
  // Auth middleware: only respond to allowed user
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
        'Schreib mir frei heraus, z.B.:\n' +
        '• „Haben wir alle Kinder in der spanischen KV angemeldet?"\n' +
        '• „Was steht beim Stb gerade an?"\n' +
        '• „Wann ist der Termin mit Jochen?"\n\n' +
        'Commands:\n' +
        '/status — pending Tasks + offene Topics\n' +
        '/topics — Liste aller offenen Topics\n' +
        '/help — dieser Text',
    )
  })

  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Stell mir Fragen zu deinen Vorgängen — ich antworte aus dem Life State (klassifizierte Mails, Topics, Tasks).\n\n' +
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
      await ctx.reply('Alles im grünen Bereich. Keine pending Tasks, keine offenen Topics.')
      return
    }

    const tasksList = pendingTasks
      .slice(0, 5)
      .map((t, i) => {
        const desc = t.description ?? ''
        const trimmed =
          desc.length > 250 ? desc.slice(0, 250) + '…' : desc
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

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    if (text.startsWith('/')) return

    logger.info(
      { fromId: ctx.from?.id, text: text.slice(0, 200) },
      'telegram query received',
    )

    await ctx.api.sendChatAction(ctx.chat.id, 'typing')

    try {
      const answer = await answerQuery(text)
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
