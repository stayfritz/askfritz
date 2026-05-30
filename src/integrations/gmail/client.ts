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
 * List inbox messages. Filters:
 *  - `afterTimestamp` (epoch seconds, preferred for polling): use Gmail's `after:` operator
 *  - `newerThanDays` (rougher, useful for one-shot queries): uses `newer_than:Nd`
 *  - both omitted: returns the most recent N inbox messages
 *
 * Paginates through ALL matching messages up to `maxTotal` (default 500).
 * Earlier versions stopped at the first Gmail page (~50 results), which
 * silently dropped older messages once the watermark advanced past them.
 */
export async function listRecentInbox(
  gmail: gmail_v1.Gmail,
  options: {
    afterTimestamp?: number
    newerThanDays?: number
    maxResults?: number
    pageSize?: number
  } = {},
): Promise<ListedMessage[]> {
  const qParts = ['label:inbox']
  if (options.afterTimestamp !== undefined) {
    qParts.push(`after:${Math.floor(options.afterTimestamp)}`)
  } else if (options.newerThanDays !== undefined) {
    qParts.push(`newer_than:${options.newerThanDays}d`)
  }
  const q = qParts.join(' ')
  const maxTotal = options.maxResults ?? 500
  const pageSize = options.pageSize ?? 100

  const out: ListedMessage[] = []
  let pageToken: string | undefined

  while (out.length < maxTotal) {
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: Math.min(pageSize, maxTotal - out.length),
      ...(pageToken ? { pageToken } : {}),
    })
    for (const m of data.messages ?? []) {
      if (typeof m.id === 'string' && typeof m.threadId === 'string') {
        out.push({ id: m.id, threadId: m.threadId })
      }
    }
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }

  return out
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
  /** RFC822 `Message-ID` header value, including angle brackets. Needed to thread replies. */
  messageIdHeader?: string
  /** RFC822 `References` header chain, for proper reply threading. */
  referencesHeader?: string
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

  const messageIdHeader = getHeader('Message-ID') || getHeader('Message-Id') || undefined
  const referencesHeader = getHeader('References') || undefined

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
    messageIdHeader,
    referencesHeader,
  }
}

export interface ReplyParams {
  to: string
  subject: string
  body: string
  inReplyTo: string
  references?: string
  threadId?: string
}

function encodeHeaderValue(value: string): string {
  // Quoted-printable for non-ASCII subjects (RFC 2047)
  if (/^[\x20-\x7e]*$/.test(value)) return value
  const base64 = Buffer.from(value, 'utf-8').toString('base64')
  return `=?UTF-8?B?${base64}?=`
}

function buildRawMessage(params: ReplyParams): string {
  const refs = params.references
    ? `${params.references} ${params.inReplyTo}`
    : params.inReplyTo
  const headers = [
    `To: ${params.to}`,
    `Subject: ${encodeHeaderValue(params.subject)}`,
    `In-Reply-To: ${params.inReplyTo}`,
    `References: ${refs}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ].join('\r\n')
  const raw = headers + '\r\n\r\n' + params.body
  return Buffer.from(raw, 'utf-8').toString('base64url')
}

export async function sendReply(
  gmail: gmail_v1.Gmail,
  params: ReplyParams,
): Promise<string> {
  const raw = buildRawMessage(params)
  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId: params.threadId,
    },
  })
  return result.data.id ?? ''
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
