import { google, type Auth, type gmail_v1 } from 'googleapis'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} env var not set`)
  return value
}

export function makeGmailAuth(): Auth.OAuth2Client {
  const oauth2Client = new google.auth.OAuth2(
    requireEnv('GMAIL_CLIENT_ID'),
    requireEnv('GMAIL_CLIENT_SECRET'),
  )
  oauth2Client.setCredentials({
    refresh_token: requireEnv('GMAIL_REFRESH_TOKEN'),
  })
  return oauth2Client
}

export function makeGmailClient(): gmail_v1.Gmail {
  return google.gmail({ version: 'v1', auth: makeGmailAuth() })
}

export interface ListedMessage {
  id: string
  threadId: string
}

/**
 * List inbox messages newer than the given duration.
 * Uses Gmail's query syntax: `newer_than:Nm` (minutes).
 */
export async function listRecentInbox(
  gmail: gmail_v1.Gmail,
  options: { newerThanMinutes?: number; maxResults?: number } = {},
): Promise<ListedMessage[]> {
  const minutes = options.newerThanMinutes ?? 5
  const q = `in:inbox newer_than:${minutes}m`

  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: options.maxResults ?? 50,
  })

  return (data.messages ?? []).filter(
    (m): m is ListedMessage =>
      typeof m.id === 'string' && typeof m.threadId === 'string',
  )
}

export async function fetchMessage(
  gmail: gmail_v1.Gmail,
  id: string,
): Promise<gmail_v1.Schema$Message> {
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full',
  })
  return data
}

export interface ParsedAttachment {
  filename: string
  mimeType: string
  attachmentId: string
  size: number
}

export interface ParsedMessage {
  id: string
  threadId: string
  receivedAt: Date
  from: { name?: string; email: string }
  to: string[]
  subject: string
  bodyText: string
  bodyHtml?: string
  attachments: ParsedAttachment[]
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8')
}

function parseEmailAddress(raw: string): { name?: string; email: string } {
  const trimmed = raw.trim()
  const match = trimmed.match(/^(?:"?(.+?)"?\s+)?<([^<>\s]+@[^<>\s]+)>\s*$/)
  if (match) {
    return { name: match[1]?.trim(), email: match[2]! }
  }
  return { email: trimmed }
}

export function parseMessage(raw: gmail_v1.Schema$Message): ParsedMessage {
  const headers = raw.payload?.headers ?? []
  const getHeader = (name: string): string =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ??
    ''

  const from = parseEmailAddress(getHeader('from'))
  const to = getHeader('to')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const subject = getHeader('subject')

  let bodyText = ''
  let bodyHtml: string | undefined
  const attachments: ParsedAttachment[] = []

  function walkParts(parts: gmail_v1.Schema$MessagePart[] | undefined): void {
    if (!parts) return
    for (const part of parts) {
      const mimeType = part.mimeType ?? ''
      if (mimeType === 'text/plain' && part.body?.data && !part.filename) {
        bodyText += decodeBase64Url(part.body.data)
      } else if (
        mimeType === 'text/html' &&
        part.body?.data &&
        !part.filename
      ) {
        bodyHtml = decodeBase64Url(part.body.data)
      } else if (part.filename && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          mimeType,
          attachmentId: part.body.attachmentId,
          size: part.body.size ?? 0,
        })
      }
      walkParts(part.parts)
    }
  }

  if (raw.payload?.body?.data && raw.payload.mimeType === 'text/plain') {
    bodyText = decodeBase64Url(raw.payload.body.data)
  } else {
    walkParts(raw.payload?.parts)
  }

  return {
    id: raw.id ?? '',
    threadId: raw.threadId ?? '',
    receivedAt: new Date(Number(raw.internalDate ?? '0')),
    from,
    to,
    subject,
    bodyText,
    bodyHtml,
    attachments,
  }
}

export async function downloadAttachment(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const { data } = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  })
  return Buffer.from(data.data ?? '', 'base64url')
}
