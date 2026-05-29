import { Hono } from 'hono'
import { z } from 'zod'
import { logger } from '../lib/logger.js'

const gmailPushSchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string(),
    publishTime: z.string(),
  }),
  subscription: z.string(),
})

const gmailNotificationSchema = z.object({
  emailAddress: z.string().email(),
  historyId: z.union([z.string(), z.number()]).transform(String),
})

export const gmailWebhook = new Hono()

gmailWebhook.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const push = gmailPushSchema.safeParse(body)

    if (!push.success) {
      logger.warn({ issues: push.error.issues }, 'invalid gmail push payload')
      return c.json({ ok: false, error: 'invalid payload' }, 400)
    }

    const decoded = Buffer.from(push.data.message.data, 'base64').toString(
      'utf-8',
    )

    let parsedNotification: unknown
    try {
      parsedNotification = JSON.parse(decoded)
    } catch (err) {
      logger.warn({ err, decoded }, 'gmail notification not valid JSON')
      return c.json({ ok: false, error: 'invalid notification' }, 400)
    }

    const notification = gmailNotificationSchema.safeParse(parsedNotification)
    if (!notification.success) {
      logger.warn(
        { issues: notification.error.issues },
        'invalid gmail notification payload',
      )
      return c.json({ ok: false, error: 'invalid notification' }, 400)
    }

    logger.info(
      {
        emailAddress: notification.data.emailAddress,
        historyId: notification.data.historyId,
        publishTime: push.data.message.publishTime,
      },
      'gmail push received',
    )

    // TODO(v0): fetch history delta, then dispatch to ingestion pipeline
    return c.json({ ok: true }, 200)
  } catch (err) {
    logger.error({ err }, 'gmail webhook error')
    return c.json({ ok: false, error: 'internal error' }, 500)
  }
})
