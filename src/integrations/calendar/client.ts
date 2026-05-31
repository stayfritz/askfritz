import { google, type calendar_v3 } from 'googleapis'
import { makeGmailAuth } from '../gmail/client.js'

/**
 * Reuses the same OAuth2 client as Gmail — works as long as the
 * GMAIL_REFRESH_TOKEN was generated with the Calendar scope too.
 * If the token only has Gmail scope, Calendar API calls return 403;
 * re-run scripts/google-auth.ts to regenerate with both scopes.
 */
export function makeCalendarClient(): calendar_v3.Calendar {
  return google.calendar({ version: 'v3', auth: makeGmailAuth() })
}

export interface CalendarEventInput {
  summary: string
  description?: string
  startIso: string
  endIso: string
  timezone: string
  attendees?: string[]
  location?: string
  sendInvites?: boolean
}

export interface CreatedEvent {
  id: string
  htmlLink: string
  summary: string
  start: string
  end: string
}

export async function createEvent(
  cal: calendar_v3.Calendar,
  input: CalendarEventInput,
): Promise<CreatedEvent> {
  const { data } = await cal.events.insert({
    calendarId: 'primary',
    sendUpdates: input.sendInvites ? 'all' : 'none',
    requestBody: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startIso, timeZone: input.timezone },
      end: { dateTime: input.endIso, timeZone: input.timezone },
      attendees: input.attendees?.map((email) => ({ email })),
    },
  })

  return {
    id: data.id ?? '',
    htmlLink: data.htmlLink ?? '',
    summary: data.summary ?? input.summary,
    start: data.start?.dateTime ?? input.startIso,
    end: data.end?.dateTime ?? input.endIso,
  }
}

export interface ListedEvent {
  id: string
  summary: string
  start: string
  end: string
  attendees: string[]
  location?: string
  status: string
}

export async function listEvents(
  cal: calendar_v3.Calendar,
  opts: { timeMinIso: string; timeMaxIso: string; maxResults?: number },
): Promise<ListedEvent[]> {
  const { data } = await cal.events.list({
    calendarId: 'primary',
    timeMin: opts.timeMinIso,
    timeMax: opts.timeMaxIso,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: opts.maxResults ?? 50,
  })

  return (data.items ?? [])
    .filter((e) => e.status !== 'cancelled')
    .map((e) => ({
      id: e.id ?? '',
      summary: e.summary ?? '(kein Titel)',
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      attendees: (e.attendees ?? [])
        .map((a) => a.email)
        .filter((s): s is string => typeof s === 'string'),
      location: e.location ?? undefined,
      status: e.status ?? 'confirmed',
    }))
}

export interface FreeSlot {
  startIso: string
  endIso: string
  durationMinutes: number
}

/**
 * Find contiguous free slots between timeMin and timeMax that are at least
 * `minDurationMinutes` long. Uses Calendar freebusy API on the primary calendar.
 */
export async function findFreeSlots(
  cal: calendar_v3.Calendar,
  opts: {
    timeMinIso: string
    timeMaxIso: string
    minDurationMinutes: number
  },
): Promise<FreeSlot[]> {
  const { data } = await cal.freebusy.query({
    requestBody: {
      timeMin: opts.timeMinIso,
      timeMax: opts.timeMaxIso,
      items: [{ id: 'primary' }],
    },
  })

  const busy = (data.calendars?.primary?.busy ?? [])
    .map((b) => ({
      start: new Date(b.start ?? opts.timeMinIso),
      end: new Date(b.end ?? opts.timeMinIso),
    }))
    .filter((b) => !isNaN(b.start.getTime()) && !isNaN(b.end.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime())

  const windowStart = new Date(opts.timeMinIso)
  const windowEnd = new Date(opts.timeMaxIso)
  const minMs = opts.minDurationMinutes * 60_000

  const free: FreeSlot[] = []
  let cursor = windowStart

  for (const b of busy) {
    if (b.start.getTime() > cursor.getTime()) {
      const gapMs = b.start.getTime() - cursor.getTime()
      if (gapMs >= minMs) {
        free.push({
          startIso: cursor.toISOString(),
          endIso: b.start.toISOString(),
          durationMinutes: Math.floor(gapMs / 60_000),
        })
      }
    }
    if (b.end.getTime() > cursor.getTime()) cursor = b.end
  }

  if (windowEnd.getTime() > cursor.getTime()) {
    const gapMs = windowEnd.getTime() - cursor.getTime()
    if (gapMs >= minMs) {
      free.push({
        startIso: cursor.toISOString(),
        endIso: windowEnd.toISOString(),
        durationMinutes: Math.floor(gapMs / 60_000),
      })
    }
  }

  return free
}
