import type { Bot } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { logger } from './logger.js'

let registeredBot: Bot | null = null
let registeredUserId: number | null = null

export function registerNotifier(bot: Bot, userId: number): void {
  registeredBot = bot
  registeredUserId = userId
}

export function isNotifierReady(): boolean {
  return registeredBot !== null && registeredUserId !== null
}

const MAX_TG_LEN = 3800

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n…[gekürzt]' : s
}

/** Trim to a single short line — for compact cards. */
function shortLine(s: string, max = 140): string {
  const cleaned = s.replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned
}

function shortSender(name: string | undefined, email: string): string {
  if (name && name.trim()) return name.trim()
  // strip role tags like "+statements" → "invoice"
  const local = email.split('@')[0] ?? email
  return local
}

function escapeMd(s: string): string {
  // Markdown V1 — only need to escape * _ ` and [ in chat-shown text.
  return s.replace(/([_*`\[\]])/g, '\\$1')
}

export interface DraftNotification {
  taskId: string
  fromName?: string | undefined
  fromEmail: string
  subject: string
  summary: string
  draftText: string
  urgency: 'low' | 'med' | 'high'
  /** Set true when the sender isn't in the persons DB — adds [👤 Anlegen] button. */
  senderUnknown?: boolean
}

export async function notifyDraft(input: DraftNotification): Promise<void> {
  if (!registeredBot || registeredUserId === null) {
    logger.debug('notifier not registered, skipping draft notification')
    return
  }

  const sender = shortSender(input.fromName, input.fromEmail)
  const urgencyIcon =
    input.urgency === 'high' ? '🔴' : input.urgency === 'med' ? '🟡' : '⚪'

  // Compact: icon · sender · subject
  //          summary (1-2 lines)
  const text =
    `${urgencyIcon} *${escapeMd(sender)}* · ${escapeMd(shortLine(input.subject, 80))}\n` +
    `${escapeMd(shortLine(input.summary, 160))}`

  // Two card variants:
  // - "draft ready": full action buttons (sender known, drafter already ran)
  // - "no draft yet": [📝 Draft erstellen] + lighter buttons (unknown sender,
  //   drafter skipped to save Sonnet calls until user explicitly asks)
  const hasDraft = input.draftText.trim().length > 0

  const keyboard = new InlineKeyboard()
  if (hasDraft) {
    keyboard
      .text('✅ Senden', `approve:${input.taskId}`)
      .text('✏️ Bearbeiten', `edit:${input.taskId}`)
      .row()
      .text('📖 Mehr', `extend:${input.taskId}`)
      .text('✓ Erledigt', `done:${input.taskId}`)
      .text('🗑', `discard:${input.taskId}`)
  } else {
    keyboard
      .text('📝 Draft erstellen', `gen_draft:${input.taskId}`)
      .text('✓ Erledigt', `done:${input.taskId}`)
      .row()
      .text('📖 Mehr', `extend:${input.taskId}`)
      .text('🗑', `discard:${input.taskId}`)
  }
  if (input.senderUnknown) {
    keyboard.row().text('👤 Sender anlegen', `person_add:${input.taskId}`)
  }

  await safeSend(text, keyboard)
}

export interface ForwardNotification {
  taskId: string
  fromName?: string | undefined
  fromEmail: string
  subject: string
  summary: string
  forwardTo: string
  ruleName: string
  coverNote: string
  attachments: string[]
  urgency: 'low' | 'med' | 'high'
  senderUnknown?: boolean
}

export async function notifyForward(input: ForwardNotification): Promise<void> {
  if (!registeredBot || registeredUserId === null) {
    logger.debug('notifier not registered, skipping forward notification')
    return
  }

  const sender = shortSender(input.fromName, input.fromEmail)
  const urgencyIcon =
    input.urgency === 'high' ? '🔴' : input.urgency === 'med' ? '🟡' : '⚪'
  const attCount = input.attachments.length
  const attLabel = attCount === 0 ? '' : ` · 📎 ${attCount}`

  const text =
    `${urgencyIcon} *${escapeMd(sender)}* → \`${escapeMd(input.forwardTo)}\`${attLabel}\n` +
    `${escapeMd(shortLine(input.subject, 160))}`

  const keyboard = new InlineKeyboard()
    .text('✅ Weiterleiten', `forward:${input.taskId}`)
    .text('✏️ Empfänger', `fwd_edit:${input.taskId}`)
    .row()
    .text('📖 Mehr', `extend:${input.taskId}`)
    .text('✓ Erledigt', `done:${input.taskId}`)
    .text('🗑', `discard:${input.taskId}`)
  if (input.senderUnknown) {
    keyboard.row().text('👤 Sender anlegen', `person_add:${input.taskId}`)
  }

  await safeSend(text, keyboard)
}

export interface FyiNotification {
  taskId: string
  fromName?: string | undefined
  fromEmail: string
  subject: string
  summary: string
  urgency: 'low' | 'med' | 'high'
  /** "Vertrag", "Bank-Kontakt", "Hochpriorität" — wird als Begründung gezeigt. */
  reason: string
  senderUnknown?: boolean
}

export async function notifyFyi(input: FyiNotification): Promise<void> {
  if (!registeredBot || registeredUserId === null) {
    logger.debug('notifier not registered, skipping fyi notification')
    return
  }

  const sender = shortSender(input.fromName, input.fromEmail)
  const urgencyIcon =
    input.urgency === 'high' ? '🔴' : input.urgency === 'med' ? '📌' : '⚪'

  const text =
    `${urgencyIcon} *${escapeMd(sender)}* · _${escapeMd(input.reason)}_\n` +
    `${escapeMd(shortLine(input.subject, 80))}\n` +
    `${escapeMd(shortLine(input.summary, 160))}`

  const keyboard = new InlineKeyboard()
    .text('📖 Mehr', `extend:${input.taskId}`)
    .text('✓ Gesehen', `done:${input.taskId}`)
    .text('🗑', `discard:${input.taskId}`)
  if (input.senderUnknown) {
    keyboard.row().text('👤 Sender anlegen', `person_add:${input.taskId}`)
  }

  await safeSend(text, keyboard)
}

export interface CalendarEventNotification {
  taskId: string
  summary: string
  description?: string
  startIso: string
  endIso: string
  timezone: string
  attendees?: string[]
  location?: string
  sendInvites?: boolean
}

function formatLocal(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString('de-DE', {
      timeZone: tz,
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function formatLocalTime(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString('de-DE', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export async function notifyCalendarEvent(
  input: CalendarEventNotification,
): Promise<void> {
  if (!registeredBot || registeredUserId === null) {
    logger.debug('notifier not registered, skipping calendar notification')
    return
  }

  const start = formatLocal(input.startIso, input.timezone)
  const endTime = formatLocalTime(input.endIso, input.timezone)
  const attCount = (input.attendees ?? []).length
  const attLabel = attCount === 0 ? '' : ` · 👥 ${attCount}`

  const text =
    `🗓 *${escapeMd(input.summary)}*${attLabel}\n` +
    `${start}–${endTime}` +
    (input.location ? ` · ${escapeMd(shortLine(input.location, 60))}` : '')

  const keyboard = new InlineKeyboard()
    .text('✅ Eintragen', `cal_create:${input.taskId}`)
    .text('✏️ Ändern', `cal_edit:${input.taskId}`)
    .row()
    .text('📖 Mehr', `extend:${input.taskId}`)
    .text('✓ Erledigt', `done:${input.taskId}`)
    .text('🗑', `discard:${input.taskId}`)

  await safeSend(text, keyboard)
}

/**
 * Posts a detailed follow-up message for a task when the user taps 📖 Mehr.
 * Content depends on task kind: full draft / full cover note / event details.
 */
export async function notifyExtended(detail: {
  taskKind: 'reply' | 'forward' | 'calendar_event'
  subject?: string
  from?: string
  to?: string
  body: string
}): Promise<void> {
  if (!registeredBot || registeredUserId === null) return

  const header =
    detail.taskKind === 'reply'
      ? '📝 *Voller Antwort-Entwurf*'
      : detail.taskKind === 'forward'
        ? '📤 *Voller Weiterleitungs-Inhalt*'
        : '🗓 *Termin-Details*'

  const meta = [
    detail.from ? `Von: ${detail.from}` : null,
    detail.to ? `An: ${detail.to}` : null,
    detail.subject ? `Betreff: ${detail.subject}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  const text =
    `${header}\n\n` +
    (meta ? `${escapeMd(meta)}\n\n` : '') +
    '```\n' +
    truncate(detail.body, MAX_TG_LEN - 200) +
    '\n```'

  await safeSend(text)
}

/* ---------------- Rankwell webhook → Telegram ---------------- */

export interface RankwellActionNotification {
  id: string
  agent: string
  actionType: string
  hypothesis: string
  page?: string
  cluster?: string
  target?: {
    metric?: string
    expectedDelta?: number
    unit?: string
    windowDays?: number
  }
  reasoning?: string
  rankwellUrl: string
}

/**
 * Render a Rankwell action.proposed event as a Telegram message with
 * inline [Approve] / [Reject] / [Open] buttons. The button callbacks
 * carry the action id via `rw-approve:<id>` / `rw-reject:<id>` / no
 * callback for the URL button (it's a deep link).
 */
export async function notifyRankwellAction(
  input: RankwellActionNotification,
): Promise<void> {
  if (!registeredBot || registeredUserId === null) {
    logger.debug('notifier not registered, skipping rankwell action')
    return
  }

  const target = input.target
  const targetLine = target?.metric
    ? `${target.metric} expected ${target.expectedDelta != null && target.expectedDelta > 0 ? '+' : ''}${target.expectedDelta ?? 0}${target.unit ?? ''} over ${target.windowDays ?? 28}d`
    : null

  const pageRef = input.page ? shortLine(input.page, 80) : '—'

  const lines = [
    `🟢 *Rankwell* · ${escapeMd(input.agent)} · ${escapeMd(input.actionType)}`,
    escapeMd(shortLine(input.hypothesis, 280)),
  ]
  if (targetLine) {
    lines.push('', `_Target:_ ${escapeMd(targetLine)}`)
  }
  if (input.reasoning) {
    lines.push('', `_${escapeMd(shortLine(input.reasoning, 200))}_`)
  }
  lines.push('', `\`${escapeMd(pageRef)}\``)

  const keyboard = new InlineKeyboard()
    .text('✅ Genehmigen', `rw-approve:${input.id}`)
    .text('✖️ Ablehnen', `rw-reject:${input.id}`)
    .row()
    .url('📂 In Rankwell öffnen', input.rankwellUrl)

  await safeSend(lines.join('\n'), keyboard)
}

export interface RankwellRecommendationNotification {
  id: string
  title: string
  summary: string
  severity: 'high' | 'medium' | 'low'
  impactEstimate?: string | null
  affectedCount?: number
  suggestedActionCount?: number
  rankwellUrl: string
}

/**
 * Render a Rankwell recommendation.proposed event as a Telegram message.
 * Inline buttons: Implement / Dismiss / Open. One message per
 * recommendation (operator requested no aggregation).
 */
export async function notifyRankwellRecommendation(
  input: RankwellRecommendationNotification,
): Promise<void> {
  if (!registeredBot || registeredUserId === null) {
    logger.debug('notifier not registered, skipping rankwell recommendation')
    return
  }

  const sevIcon =
    input.severity === 'high' ? '🔴' : input.severity === 'medium' ? '🟡' : '⚪'

  const lines = [
    `${sevIcon} *Rankwell-Empfehlung* · ${escapeMd(input.severity)}`,
    `*${escapeMd(shortLine(input.title, 120))}*`,
    '',
    escapeMd(truncate(input.summary, 800)),
  ]
  const meta: string[] = []
  if (input.impactEstimate) meta.push(`💡 ${input.impactEstimate}`)
  if (input.affectedCount && input.affectedCount > 0) {
    meta.push(`📄 ${input.affectedCount} Seiten`)
  }
  if (input.suggestedActionCount && input.suggestedActionCount > 0) {
    meta.push(`🤖 ${input.suggestedActionCount} Aktionen bereit`)
  }
  if (meta.length > 0) lines.push('', escapeMd(meta.join(' · ')))

  const keyboard = new InlineKeyboard()
    .text('✅ Umsetzen', `rw-rec-impl:${input.id}`)
    .text('✖️ Verwerfen', `rw-rec-dismiss:${input.id}`)
    .row()
    .url('📂 Öffnen', input.rankwellUrl)

  await safeSend(lines.join('\n'), keyboard)
}

async function safeSend(
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  if (!registeredBot || registeredUserId === null) return
  try {
    await registeredBot.api.sendMessage(registeredUserId, text, {
      ...(keyboard ? { reply_markup: keyboard } : {}),
      parse_mode: 'Markdown',
    })
  } catch (err) {
    // Markdown parse can fail on special chars — retry as plain
    logger.warn({ err }, 'markdown send failed, retrying as plain text')
    // crude unescape of our markdown
    const plain = text
      .replace(/\\([_*`\[\]])/g, '$1')
      .replace(/\*/g, '')
      .replace(/`/g, '')
    await registeredBot.api.sendMessage(registeredUserId, plain, {
      ...(keyboard ? { reply_markup: keyboard } : {}),
    })
  }
}

export async function notifyText(message: string): Promise<void> {
  if (!registeredBot || registeredUserId === null) return
  await registeredBot.api.sendMessage(registeredUserId, message)
}
