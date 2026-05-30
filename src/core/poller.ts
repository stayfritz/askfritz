import { desc } from 'drizzle-orm'
import { db } from '../integrations/postgres/db.js'
import { documents } from '../integrations/postgres/schema.js'
import {
  fetchMessage,
  listRecentInbox,
  makeGmailClient,
  parseMessage,
} from '../integrations/gmail/client.js'
import { ingestMessage } from './ingestion.js'
import { logger } from '../lib/logger.js'

const POLL_INTERVAL_MS = 30_000
const WATERMARK_BUFFER_SEC = 60
const INITIAL_LOOKBACK_HOURS = 24
const MAX_MESSAGES_PER_CYCLE = 500

/**
 * BACKFILL_SINCE (ISO date or "Nd" like "7d") — once-on-boot override that
 * pulls all inbox mail since the given point regardless of watermark.
 * Set in env when you need to recover from a watermark gap. Idempotent
 * (ingestion skips by sourceId), so safe to leave set across restarts —
 * just removes the env var when no longer needed.
 */
function parseBackfillSince(): Date | null {
  const raw = process.env.BACKFILL_SINCE?.trim()
  if (!raw) return null
  const daysMatch = raw.match(/^(\d+)d$/)
  if (daysMatch && daysMatch[1]) {
    const days = Number.parseInt(daysMatch[1], 10)
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  }
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    logger.warn({ raw }, 'BACKFILL_SINCE could not be parsed, ignoring')
    return null
  }
  return parsed
}

export class GmailPoller {
  private timer: NodeJS.Timeout | null = null
  private isPolling = false
  private firstCycle = true

  start(): void {
    if (this.timer) return
    logger.info({ intervalMs: POLL_INTERVAL_MS }, 'gmail poller started')
    this.timer = setInterval(() => {
      void this.pollOnce()
    }, POLL_INTERVAL_MS)
    void this.pollOnce()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      logger.info('gmail poller stopped')
    }
  }

  async pollOnce(): Promise<{
    ingested: number
    skipped: number
    failed: number
  }> {
    if (this.isPolling) {
      logger.debug('poll skip — previous cycle still running')
      return { ingested: 0, skipped: 0, failed: 0 }
    }
    this.isPolling = true

    try {
      const isFirst = this.firstCycle
      this.firstCycle = false

      const watermark = await this.getWatermark()
      const backfillSince = isFirst ? parseBackfillSince() : null
      const effectiveSince =
        backfillSince && backfillSince.getTime() < watermark.getTime()
          ? backfillSince
          : watermark
      const afterTs =
        Math.floor(effectiveSince.getTime() / 1000) - WATERMARK_BUFFER_SEC

      const gmail = makeGmailClient()
      const messages = await listRecentInbox(gmail, {
        afterTimestamp: afterTs,
        maxResults: MAX_MESSAGES_PER_CYCLE,
      })

      if (messages.length === 0) {
        logger.debug(
          { since: effectiveSince.toISOString() },
          'no new mail',
        )
        return { ingested: 0, skipped: 0, failed: 0 }
      }

      logger.info(
        {
          count: messages.length,
          since: effectiveSince.toISOString(),
          mode: backfillSince ? 'backfill' : 'incremental',
        },
        'polling mail',
      )

      let ingested = 0
      let skipped = 0
      let failed = 0

      for (const m of messages) {
        try {
          const raw = await fetchMessage(gmail, m.id)
          const parsed = parseMessage(raw)
          const result = await ingestMessage(parsed)
          if (result.status === 'ingested') ingested++
          else if (result.status === 'skipped') skipped++
          else if (result.status === 'failed') failed++
        } catch (err) {
          logger.error(
            { err, messageId: m.id },
            'message processing failed',
          )
          failed++
        }
      }

      logger.info({ ingested, skipped, failed }, 'poll cycle done')
      return { ingested, skipped, failed }
    } catch (err) {
      logger.error({ err }, 'poll cycle errored')
      return { ingested: 0, skipped: 0, failed: 0 }
    } finally {
      this.isPolling = false
    }
  }

  private async getWatermark(): Promise<Date> {
    const result = await db
      .select({ receivedAt: documents.receivedAt })
      .from(documents)
      .orderBy(desc(documents.receivedAt))
      .limit(1)

    const latest = result[0]?.receivedAt
    if (latest) return latest
    return new Date(Date.now() - INITIAL_LOOKBACK_HOURS * 60 * 60 * 1000)
  }
}
