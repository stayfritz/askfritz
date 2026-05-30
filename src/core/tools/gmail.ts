import { z } from 'zod'
import type { Tool } from './types.js'
import {
  fetchMessage,
  makeGmailClient,
  parseMessage,
} from '../../integrations/gmail/client.js'
import { logger } from '../../lib/logger.js'

// ---------------------------------------------------------------------------
// gmail_search_messages
// ---------------------------------------------------------------------------

const searchInput = z.object({
  query: z
    .string()
    .describe(
      'Gmail search query using standard operators. Searches ALL mail by default — add scope explicitly. Examples: "in:sent to:rothauski apartments" (sent folder), "from:alerts@replit.com" (inbox + everywhere), "label:inbox is:unread", "subject:invoice newer_than:30d", "in:anywhere from:me". Combine with spaces (AND).',
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(10)
    .describe('Maximum messages to return (cap at 30 for token budget).'),
})

interface SearchResult {
  message_id: string
  thread_id: string
  from: string
  to: string
  subject: string
  date: string
  snippet: string
}

export const gmailSearchMessages: Tool<
  z.infer<typeof searchInput>,
  { count: number; messages: SearchResult[] }
> = {
  name: 'gmail_search_messages',
  description:
    'Search Gmail (all folders — inbox, sent, archive, labels) using Gmail query syntax. Returns sender, recipient, subject, date, snippet. Snippets are short (~200 chars) — for full content of a specific hit, follow up with gmail_get_message. Read-only.',
  inputSchema: searchInput,
  execute: async (input) => {
    const gmail = makeGmailClient()
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: input.query,
      maxResults: input.max_results,
    })
    const ids = (list.data.messages ?? []).filter(
      (m): m is { id: string; threadId: string } =>
        typeof m.id === 'string' && typeof m.threadId === 'string',
    )

    const messages: SearchResult[] = []
    for (const m of ids) {
      const raw = await fetchMessage(gmail, m.id)
      const parsed = parseMessage(raw)
      messages.push({
        message_id: parsed.id,
        thread_id: parsed.threadId,
        from: parsed.from.name
          ? `${parsed.from.name} <${parsed.from.email}>`
          : parsed.from.email,
        to: parsed.to.join(', '),
        subject: parsed.subject,
        date: parsed.receivedAt.toISOString(),
        snippet: (raw.snippet ?? '').slice(0, 200),
      })
    }

    return { count: messages.length, messages }
  },
}

// ---------------------------------------------------------------------------
// gmail_get_message
// ---------------------------------------------------------------------------

const getMessageInput = z.object({
  message_id: z
    .string()
    .describe(
      'Gmail message_id (from gmail_search_messages). Returns full parsed body + headers for that single message.',
    ),
  max_body_chars: z
    .number()
    .int()
    .min(500)
    .max(20000)
    .default(6000)
    .describe(
      'Max chars of body to return (default 6000, hard cap 20000 for token budget).',
    ),
})

interface GetMessageResult {
  message_id: string
  thread_id: string
  from: string
  to: string
  subject: string
  date: string
  body: string
  body_truncated: boolean
  attachments: Array<{ filename: string; mime_type: string }>
}

export const gmailGetMessage: Tool<
  z.infer<typeof getMessageInput>,
  GetMessageResult
> = {
  name: 'gmail_get_message',
  description:
    'Fetch the full body + headers of one Gmail message by id. Use after gmail_search_messages when the snippet is not enough to identify or quote from the right mail. Read-only.',
  inputSchema: getMessageInput,
  execute: async (input) => {
    const gmail = makeGmailClient()
    const raw = await fetchMessage(gmail, input.message_id)
    const parsed = parseMessage(raw)
    const fullBody = parsed.bodyText ?? ''
    const truncated = fullBody.length > input.max_body_chars
    const body = truncated
      ? fullBody.slice(0, input.max_body_chars) + '\n[...truncated]'
      : fullBody
    return {
      message_id: parsed.id,
      thread_id: parsed.threadId,
      from: parsed.from.name
        ? `${parsed.from.name} <${parsed.from.email}>`
        : parsed.from.email,
      to: parsed.to.join(', '),
      subject: parsed.subject,
      date: parsed.receivedAt.toISOString(),
      body,
      body_truncated: truncated,
      attachments: parsed.attachments.map((a) => ({
        filename: a.filename,
        mime_type: a.mimeType,
      })),
    }
  },
}

// ---------------------------------------------------------------------------
// gmail_filter_create
// ---------------------------------------------------------------------------

const filterInput = z.object({
  from: z
    .string()
    .optional()
    .describe(
      'Sender email or domain to match (Gmail substring match, e.g. "alerts@replit.com" or "replit.com").',
    ),
  subject_contains: z
    .string()
    .optional()
    .describe('Subject must contain this text.'),
  query: z
    .string()
    .optional()
    .describe(
      'Generic Gmail query to match (advanced, e.g. "has:attachment from:newsletter").',
    ),
  archive: z
    .boolean()
    .default(true)
    .describe('Auto-archive matching mails (remove from inbox).'),
  mark_read: z
    .boolean()
    .default(false)
    .describe('Mark matching mails as read.'),
  apply_label_name: z
    .string()
    .optional()
    .describe(
      'Apply this label name to matching mails (label will be created if it does not exist).',
    ),
})

export const gmailFilterCreate: Tool<
  z.infer<typeof filterInput>,
  { ok: true; filter_id: string; criteria: Record<string, string> } | { ok: false; reason: string }
> = {
  name: 'gmail_filter_create',
  description:
    'Create a Gmail filter that auto-acts on matching mails (e.g. archive all from a sender). Affects future mails matching the criteria.',
  inputSchema: filterInput,
  execute: async (input) => {
    if (!input.from && !input.subject_contains && !input.query) {
      return {
        ok: false,
        reason: 'At least one of from / subject_contains / query is required.',
      }
    }

    const gmail = makeGmailClient()

    const criteria: Record<string, string> = {}
    if (input.from) criteria.from = input.from
    if (input.subject_contains) criteria.subject = input.subject_contains
    if (input.query) criteria.query = input.query

    const addLabelIds: string[] = []
    const removeLabelIds: string[] = []

    if (input.archive) removeLabelIds.push('INBOX')
    if (input.mark_read) removeLabelIds.push('UNREAD')

    if (input.apply_label_name) {
      const labels = await gmail.users.labels.list({ userId: 'me' })
      let labelId = labels.data.labels?.find(
        (l) => l.name === input.apply_label_name,
      )?.id
      if (!labelId) {
        const created = await gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name: input.apply_label_name,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
          },
        })
        labelId = created.data.id ?? undefined
      }
      if (labelId) addLabelIds.push(labelId)
    }

    const result = await gmail.users.settings.filters.create({
      userId: 'me',
      requestBody: {
        criteria,
        action: {
          addLabelIds: addLabelIds.length ? addLabelIds : undefined,
          removeLabelIds: removeLabelIds.length ? removeLabelIds : undefined,
        },
      },
    })

    logger.info(
      { filterId: result.data.id, criteria },
      'gmail filter created',
    )

    return {
      ok: true as const,
      filter_id: result.data.id ?? '',
      criteria,
    }
  },
}

// ---------------------------------------------------------------------------
// gmail_archive_matching
// ---------------------------------------------------------------------------

const archiveInput = z.object({
  query: z
    .string()
    .describe(
      'Gmail search query for messages to archive (e.g. "from:alerts@replit.com").',
    ),
  max_messages: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe('Safety cap on how many to archive.'),
})

export const gmailArchiveMatching: Tool<
  z.infer<typeof archiveInput>,
  { archived: number; cap_reached: boolean }
> = {
  name: 'gmail_archive_matching',
  description:
    'Archive (remove from INBOX) all existing messages matching the query. Use after gmail_filter_create to also clean up existing matches.',
  inputSchema: archiveInput,
  execute: async (input) => {
    const gmail = makeGmailClient()
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `${input.query} label:inbox`,
      maxResults: input.max_messages,
    })
    const ids = (list.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')

    if (ids.length === 0) {
      return { archived: 0, cap_reached: false }
    }

    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids,
        removeLabelIds: ['INBOX'],
      },
    })

    return {
      archived: ids.length,
      cap_reached: ids.length === input.max_messages,
    }
  },
}

// ---------------------------------------------------------------------------
// gmail_unsubscribe
// ---------------------------------------------------------------------------

const unsubscribeInput = z.object({
  message_id: z
    .string()
    .describe(
      'Gmail message_id of a mail from the list you want to unsubscribe from.',
    ),
})

export const gmailUnsubscribe: Tool<
  z.infer<typeof unsubscribeInput>,
  {
    ok: boolean
    method?: 'http' | 'mailto'
    url?: string
    status?: number
    reason?: string
  }
> = {
  name: 'gmail_unsubscribe',
  description:
    'Use the List-Unsubscribe header on a mail to unsubscribe (RFC 8058 one-click POST if available, else GET). Only works for senders that include this header (most legitimate newsletters do).',
  inputSchema: unsubscribeInput,
  execute: async (input) => {
    const gmail = makeGmailClient()
    const raw = await fetchMessage(gmail, input.message_id)
    const headers = raw.payload?.headers ?? []
    const getHeader = (name: string): string =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? ''

    const listUnsubscribe = getHeader('List-Unsubscribe')
    const listUnsubscribePost = getHeader('List-Unsubscribe-Post')

    if (!listUnsubscribe) {
      return {
        ok: false,
        reason: 'No List-Unsubscribe header on this message.',
      }
    }

    const urlMatches = listUnsubscribe.match(/<([^>]+)>/g) ?? []
    const urls = urlMatches.map((m) => m.slice(1, -1))
    const httpUrl = urls.find((u) => /^https?:\/\//i.test(u))
    const mailtoUrl = urls.find((u) => /^mailto:/i.test(u))

    if (httpUrl) {
      const method =
        listUnsubscribePost.includes('List-Unsubscribe=One-Click')
          ? 'POST'
          : 'GET'
      const init: RequestInit =
        method === 'POST'
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'List-Unsubscribe=One-Click',
            }
          : { method: 'GET' }
      const response = await fetch(httpUrl, init)
      return {
        ok: response.ok,
        method: 'http',
        url: httpUrl,
        status: response.status,
      }
    }

    if (mailtoUrl) {
      return {
        ok: false,
        method: 'mailto',
        url: mailtoUrl,
        reason: 'mailto-based unsubscribe is not yet implemented.',
      }
    }

    return {
      ok: false,
      reason: 'List-Unsubscribe header found but no usable URL.',
    }
  },
}
