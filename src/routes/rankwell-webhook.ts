/**
 * Inbound webhook from Rankwell. Two events:
 *   - action.proposed       (every agent-drafted action awaiting approval)
 *   - recommendation.proposed (every strategic recommendation from the
 *                              Recommendations agent, one per item)
 *
 * Auth: HMAC-SHA256 of the raw request body with the shared secret
 * RANKWELL_WEBHOOK_SECRET. Header: X-Rankwell-Signature: sha256=<hex>.
 *
 * Both events become a Telegram message with inline buttons via
 * notifier.ts; the buttons' callback_data carries the Rankwell id so
 * telegram-handler.ts can call back into Rankwell's API to actually
 * approve / reject / implement / dismiss.
 */

import { Hono } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { logger } from '../lib/logger.js'
import {
  notifyRankwellAction,
  notifyRankwellRecommendation,
} from '../lib/notifier.js'

export const rankwellWebhook = new Hono()

const actionSchema = z.object({
  event: z.literal('action.proposed'),
  id: z.string().uuid(),
  agent: z.string(),
  actionType: z.string(),
  hypothesis: z.string(),
  page: z.string().optional(),
  cluster: z.string().optional(),
  target: z
    .object({
      metric: z.string().optional(),
      expectedDelta: z.number().optional(),
      unit: z.string().optional(),
      windowDays: z.number().optional(),
    })
    .optional(),
  reasoning: z.string().optional(),
  rankwellUrl: z.string(),
  createdAt: z.string().optional(),
})

const recommendationSchema = z.object({
  event: z.literal('recommendation.proposed'),
  id: z.string().uuid(),
  title: z.string(),
  summary: z.string(),
  severity: z.enum(['high', 'medium', 'low']),
  impactEstimate: z.string().nullable().optional(),
  affectedCount: z.number().optional(),
  suggestedActionCount: z.number().optional(),
  rankwellUrl: z.string(),
  createdAt: z.string().optional(),
})

function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.RANKWELL_WEBHOOK_SECRET
  if (!secret) return false
  if (!header) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const provided = header.replace(/^sha256=/, '')
  if (provided.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
  } catch {
    return false
  }
}

rankwellWebhook.post('/', async (c) => {
  const rawBody = await c.req.text()
  const sig = c.req.header('x-rankwell-signature') ?? null

  if (!verifySignature(rawBody, sig)) {
    logger.warn('rankwell webhook: signature verification failed')
    return c.json({ error: 'invalid signature' }, 401)
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }

  const obj = parsedJson as { event?: string }

  if (obj.event === 'action.proposed') {
    const result = actionSchema.safeParse(parsedJson)
    if (!result.success) {
      logger.warn(
        { errors: result.error.flatten() },
        'rankwell webhook: action payload invalid',
      )
      return c.json({ error: 'invalid action payload' }, 400)
    }
    await notifyRankwellAction(result.data)
    return c.json({ ok: true })
  }

  if (obj.event === 'recommendation.proposed') {
    const result = recommendationSchema.safeParse(parsedJson)
    if (!result.success) {
      logger.warn(
        { errors: result.error.flatten() },
        'rankwell webhook: recommendation payload invalid',
      )
      return c.json({ error: 'invalid recommendation payload' }, 400)
    }
    await notifyRankwellRecommendation(result.data)
    return c.json({ ok: true })
  }

  return c.json({ error: 'unsupported event' }, 400)
})
