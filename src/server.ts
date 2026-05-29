import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { logger as honoLogger } from 'hono/logger'
import 'dotenv/config'
import { logger } from './lib/logger.js'
import { gmailWebhook } from './routes/gmail-webhook.js'
import { syncConfigToDb } from './core/sync-config.js'
import { GmailPoller } from './core/poller.js'

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

  logger.info('syncing config to DB...')
  await syncConfigToDb()

  const poller = new GmailPoller()
  poller.start()

  const port = Number(process.env.PORT ?? 3000)
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, 'askfritz listening')
  })

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down')
    poller.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

bootstrap().catch((err) => {
  logger.error({ err }, 'bootstrap failed')
  process.exit(1)
})
