import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { logger as honoLogger } from 'hono/logger'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import 'dotenv/config'
import { logger } from './lib/logger.js'
import { gmailWebhook } from './routes/gmail-webhook.js'
import { syncConfigToDb } from './core/sync-config.js'
import { GmailPoller } from './core/poller.js'
import {
  getAllowedUserId,
  isTelegramConfigured,
  makeBot,
} from './integrations/telegram/bot.js'
import { registerTelegramHandlers } from './core/telegram-handler.js'
import { registerNotifier } from './lib/notifier.js'
import { db } from './integrations/postgres/db.js'

const app = new Hono()

app.use('*', honoLogger((message) => logger.info(message)))

app.get('/', (c) => c.text('askfritz — alive'))

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'askfritz',
    version: '0.0.1',
    timestamp: new Date().toISOString(),
  }),
)

app.route('/webhooks/gmail', gmailWebhook)

async function bootstrap(): Promise<void> {
  logger.info('booting askfritz...')

  logger.info('running migrations...')
  await migrate(db, { migrationsFolder: './migrations' })
  logger.info('migrations applied')

  logger.info('syncing config to DB...')
  await syncConfigToDb()

  const poller = new GmailPoller()
  poller.start()

  let bot: ReturnType<typeof makeBot> | null = null
  if (isTelegramConfigured()) {
    bot = makeBot()
    const allowedUserId = getAllowedUserId()
    registerTelegramHandlers(bot, allowedUserId)
    registerNotifier(bot, allowedUserId)
    // Catch bot.start() crashes so the process stays up even if Telegram
    // long-polling fails (e.g. 409 Conflict when another instance is running).
    // App still serves /health, polls Gmail, etc. — only Telegram is silent
    // until the conflicting instance dies.
    bot
      .start({
        drop_pending_updates: true,
        onStart: (info) => {
          logger.info(
            { username: info.username, allowedUserId },
            'telegram bot started',
          )
        },
      })
      .catch((err) => {
        logger.error(
          { err: err instanceof Error ? err.message : err },
          'telegram bot crashed — process continues, will retry on next restart',
        )
      })
  } else {
    logger.warn(
      'telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USER_ID), skipping',
    )
  }

  const port = Number(process.env.PORT ?? 3000)
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, 'askfritz listening')
  })

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down')
    poller.stop()
    if (bot) await bot.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

bootstrap().catch((err) => {
  logger.error({ err }, 'bootstrap failed')
  process.exit(1)
})
