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

export interface DraftNotification {
  taskId: string
  fromName?: string | undefined
  fromEmail: string
  subject: string
  summary: string
  draftText: string
  urgency: 'low' | 'med' | 'high'
}

export async function notifyDraft(
  input: DraftNotification,
): Promise<void> {
  if (!registeredBot || registeredUserId === null) {
    logger.debug('notifier not registered, skipping draft notification')
    return
  }

  const senderLabel = input.fromName
    ? `${input.fromName} <${input.fromEmail}>`
    : input.fromEmail

  const urgencyIcon =
    input.urgency === 'high' ? '🔴' : input.urgency === 'med' ? '🟡' : '⚪'

  const text =
    `${urgencyIcon} *Antwort-Entwurf für dich*\n\n` +
    `*Von:* ${senderLabel}\n` +
    `*Betreff:* ${input.subject}\n\n` +
    `*Worum es geht:*\n${truncate(input.summary, 600)}\n\n` +
    `*Mein Entwurf:*\n\`\`\`\n${truncate(input.draftText, MAX_TG_LEN - 1000)}\n\`\`\``

  const keyboard = new InlineKeyboard()
    .text('✅ Senden', `approve:${input.taskId}`)
    .text('✏️ Bearbeiten', `edit:${input.taskId}`)
    .text('🗑 Verwerfen', `discard:${input.taskId}`)

  try {
    await registeredBot.api.sendMessage(registeredUserId, text, {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
    })
  } catch (err) {
    // Markdown parse can fail on special chars — retry as plain
    logger.warn({ err }, 'markdown send failed, retrying as plain text')
    const plainText =
      `${urgencyIcon} Antwort-Entwurf für dich\n\n` +
      `Von: ${senderLabel}\n` +
      `Betreff: ${input.subject}\n\n` +
      `Worum es geht:\n${truncate(input.summary, 600)}\n\n` +
      `Mein Entwurf:\n${truncate(input.draftText, MAX_TG_LEN - 600)}`
    await registeredBot.api.sendMessage(registeredUserId, plainText, {
      reply_markup: keyboard,
    })
  }
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
}

export async function notifyForward(input: ForwardNotification): Promise<void> {
  if (!registeredBot || registeredUserId === null) {
    logger.debug('notifier not registered, skipping forward notification')
    return
  }

  const senderLabel = input.fromName
    ? `${input.fromName} <${input.fromEmail}>`
    : input.fromEmail
  const urgencyIcon =
    input.urgency === 'high' ? '🔴' : input.urgency === 'med' ? '🟡' : '⚪'
  const attLine =
    input.attachments.length === 0
      ? '(keine)'
      : input.attachments.map((f) => `• ${f}`).join('\n')

  const text =
    `${urgencyIcon} *Weiterleitung vorgeschlagen* (${input.ruleName})\n\n` +
    `*Von:*       ${senderLabel}\n` +
    `*Betreff:*   ${input.subject}\n` +
    `*An:*        ${input.forwardTo}\n\n` +
    `*Worum es geht:*\n${truncate(input.summary, 500)}\n\n` +
    `*Anhänge:*\n${attLine}\n\n` +
    `*Begleittext:*\n\`\`\`\n${truncate(input.coverNote, 800)}\n\`\`\``

  const keyboard = new InlineKeyboard()
    .text('✅ Weiterleiten', `forward:${input.taskId}`)
    .text('✏️ Empfänger ändern', `fwd_edit:${input.taskId}`)
    .text('🗑 Verwerfen', `discard:${input.taskId}`)

  try {
    await registeredBot.api.sendMessage(registeredUserId, text, {
      reply_markup: keyboard,
      parse_mode: 'Markdown',
    })
  } catch (err) {
    logger.warn({ err }, 'markdown send failed, retrying as plain text')
    const plainText =
      `${urgencyIcon} Weiterleitung vorgeschlagen (${input.ruleName})\n\n` +
      `Von: ${senderLabel}\n` +
      `Betreff: ${input.subject}\n` +
      `An: ${input.forwardTo}\n\n` +
      `Worum es geht:\n${truncate(input.summary, 500)}\n\n` +
      `Anhänge:\n${attLine}\n\n` +
      `Begleittext:\n${truncate(input.coverNote, 800)}`
    await registeredBot.api.sendMessage(registeredUserId, plainText, {
      reply_markup: keyboard,
    })
  }
}

export async function notifyText(message: string): Promise<void> {
  if (!registeredBot || registeredUserId === null) return
  await registeredBot.api.sendMessage(registeredUserId, message)
}
