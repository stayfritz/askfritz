import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { logger as honoLogger } from 'hono/logger'
import 'dotenv/config'
import { logger } from './lib/logger.js'
import { gmailWebhook } from './routes/gmail-webhook.js'

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

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, 'askfritz listening')
})
