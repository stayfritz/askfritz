import { and, desc, eq, isNotNull, lt } from 'drizzle-orm'
import { db } from '../integrations/postgres/db.js'
import { threads } from '../integrations/postgres/schema.js'

export interface StaleThread {
  externalId: string | null
  domainId: string | null
  topicId: string | null
  participants: string[]
  status: 'waiting_user' | 'waiting_partner'
  lastMessageAt: Date | null
  summary: string | null
  daysStale: number
}

/**
 * Threshold defaults: a thread is considered stale when it sits in
 * `waiting_user` longer than 1 day (Thomas owes a reply that didn't happen)
 * or `waiting_partner` longer than 5 days (the other side isn't responding).
 */
const DEFAULT_WAITING_USER_DAYS = 1
const DEFAULT_WAITING_PARTNER_DAYS = 5

export async function findStaleThreads(options?: {
  waitingUserDays?: number
  waitingPartnerDays?: number
}): Promise<StaleThread[]> {
  const wuDays = options?.waitingUserDays ?? DEFAULT_WAITING_USER_DAYS
  const wpDays = options?.waitingPartnerDays ?? DEFAULT_WAITING_PARTNER_DAYS
  const now = Date.now()
  const wuCutoff = new Date(now - wuDays * 86400_000)
  const wpCutoff = new Date(now - wpDays * 86400_000)

  const [wu, wp] = await Promise.all([
    db
      .select()
      .from(threads)
      .where(
        and(
          eq(threads.status, 'waiting_user'),
          isNotNull(threads.lastMessageAt),
          lt(threads.lastMessageAt, wuCutoff),
        ),
      )
      .orderBy(desc(threads.lastMessageAt)),
    db
      .select()
      .from(threads)
      .where(
        and(
          eq(threads.status, 'waiting_partner'),
          isNotNull(threads.lastMessageAt),
          lt(threads.lastMessageAt, wpCutoff),
        ),
      )
      .orderBy(desc(threads.lastMessageAt)),
  ])

  const toStale = (
    rows: typeof wu,
    status: 'waiting_user' | 'waiting_partner',
  ): StaleThread[] =>
    rows.map((t) => ({
      externalId: t.externalId,
      domainId: t.domainId,
      topicId: t.topicId,
      participants: t.participants ?? [],
      status,
      lastMessageAt: t.lastMessageAt,
      summary: t.summary,
      daysStale: t.lastMessageAt
        ? Math.floor((now - t.lastMessageAt.getTime()) / 86400_000)
        : 0,
    }))

  return [...toStale(wu, 'waiting_user'), ...toStale(wp, 'waiting_partner')]
}
