import { z } from 'zod'
import type { Tool } from './types.js'
import {
  findFreeSlots,
  listEvents,
  makeCalendarClient,
} from '../../integrations/calendar/client.js'
import { db } from '../../integrations/postgres/db.js'
import { tasks } from '../../integrations/postgres/schema.js'
import { notifyCalendarEvent } from '../../lib/notifier.js'
import { logger } from '../../lib/logger.js'

const DEFAULT_TZ = 'Europe/Berlin'

// ---------------------------------------------------------------------------
// calendar_propose_event
// ---------------------------------------------------------------------------

const proposeEventInput = z.object({
  summary: z.string().describe('Termin-Titel, z.B. "Besprechung Anke".'),
  description: z
    .string()
    .optional()
    .describe('Optionaler Beschreibungstext / Notizen für den Termin.'),
  start_iso: z
    .string()
    .datetime({ offset: true })
    .describe(
      'Start als ISO 8601 mit Offset, z.B. "2026-06-14T14:00:00+02:00".',
    ),
  end_iso: z
    .string()
    .datetime({ offset: true })
    .describe('Ende als ISO 8601 mit Offset.'),
  timezone: z
    .string()
    .default(DEFAULT_TZ)
    .describe('IANA-Zeitzone (Default Europe/Berlin).'),
  attendees: z
    .array(z.string().email())
    .optional()
    .describe('Optionale Liste an Email-Adressen, die eingeladen werden sollen.'),
  location: z
    .string()
    .optional()
    .describe('Optional: Ort oder Videocall-Link.'),
  send_invites: z
    .boolean()
    .default(false)
    .describe(
      'Ob Einladungs-Mails an Attendees rausgehen sollen. Default false, weil Thomas oft selbst entscheidet ob die Einladung formell rausgeht.',
    ),
})

export const calendarProposeEvent: Tool<
  z.infer<typeof proposeEventInput>,
  { ok: boolean; task_id?: string; reason?: string }
> = {
  name: 'calendar_propose_event',
  description:
    'Schlage Thomas einen neuen Termin im Google Calendar vor. Erzeugt eine Telegram-Karte mit ✅ Eintragen / ✏️ Ändern / 🗑 Verwerfen. Der Termin wird NICHT direkt angelegt — erst Thomas-Approval nötig. Schreib den Termin-Text NICHT zusätzlich in den Chat, kurz bestätigen reicht ("Karte ist raus"). Wenn du nicht sicher bist ob ein Slot frei ist, vorher calendar_find_free_slot.',
  inputSchema: proposeEventInput,
  execute: async (input) => {
    const payload = {
      summary: input.summary,
      ...(input.description ? { description: input.description } : {}),
      start_iso: input.start_iso,
      end_iso: input.end_iso,
      timezone: input.timezone,
      ...(input.attendees ? { attendees: input.attendees } : {}),
      ...(input.location ? { location: input.location } : {}),
      send_invites: input.send_invites,
    }

    const [task] = await db
      .insert(tasks)
      .values({
        kind: 'calendar_event',
        description: `Calendar: ${input.summary}`,
        status: 'pending_user',
        requiresDecision: true,
        calendarPayload: payload,
      })
      .returning({ id: tasks.id })
    if (!task) return { ok: false, reason: 'task insert failed' }

    await notifyCalendarEvent({
      taskId: task.id,
      summary: input.summary,
      ...(input.description ? { description: input.description } : {}),
      startIso: input.start_iso,
      endIso: input.end_iso,
      timezone: input.timezone,
      ...(input.attendees ? { attendees: input.attendees } : {}),
      ...(input.location ? { location: input.location } : {}),
      sendInvites: input.send_invites,
    })

    logger.info(
      { taskId: task.id, summary: input.summary, start: input.start_iso },
      'calendar event proposed',
    )

    return { ok: true, task_id: task.id }
  },
}

// ---------------------------------------------------------------------------
// calendar_list_events
// ---------------------------------------------------------------------------

const listEventsInput = z.object({
  time_min_iso: z
    .string()
    .datetime({ offset: true })
    .describe('Untergrenze des Zeitfensters, ISO 8601 mit Offset.'),
  time_max_iso: z
    .string()
    .datetime({ offset: true })
    .describe('Obergrenze des Zeitfensters, ISO 8601 mit Offset.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe('Max Anzahl Events.'),
})

export const calendarListEvents: Tool<
  z.infer<typeof listEventsInput>,
  {
    count: number
    events: Array<{
      id: string
      summary: string
      start: string
      end: string
      attendees: string[]
      location?: string
    }>
  }
> = {
  name: 'calendar_list_events',
  description:
    'Liste Termine im primary Kalender zwischen time_min und time_max (ISO mit Offset). Read-only — keine Veränderung. Nutze für Fragen wie "was steht morgen an" oder vor calendar_propose_event um Konflikte zu sehen.',
  inputSchema: listEventsInput,
  execute: async (input) => {
    const cal = makeCalendarClient()
    const events = await listEvents(cal, {
      timeMinIso: input.time_min_iso,
      timeMaxIso: input.time_max_iso,
      maxResults: input.max_results,
    })
    return {
      count: events.length,
      events: events.map((e) => ({
        id: e.id,
        summary: e.summary,
        start: e.start,
        end: e.end,
        attendees: e.attendees,
        ...(e.location ? { location: e.location } : {}),
      })),
    }
  },
}

// ---------------------------------------------------------------------------
// calendar_find_free_slot
// ---------------------------------------------------------------------------

const findFreeSlotInput = z.object({
  time_min_iso: z.string().datetime({ offset: true }),
  time_max_iso: z.string().datetime({ offset: true }),
  duration_minutes: z
    .number()
    .int()
    .min(15)
    .max(480)
    .describe('Minimal-Dauer eines freien Slots in Minuten.'),
})

export const calendarFindFreeSlot: Tool<
  z.infer<typeof findFreeSlotInput>,
  {
    count: number
    slots: Array<{ start_iso: string; end_iso: string; duration_minutes: number }>
  }
> = {
  name: 'calendar_find_free_slot',
  description:
    'Finde freie Slots im primary Kalender zwischen time_min und time_max, die mindestens duration_minutes lang sind. Nutzt freebusy API. Read-only. Vor calendar_propose_event verwenden um Konflikte zu vermeiden.',
  inputSchema: findFreeSlotInput,
  execute: async (input) => {
    const cal = makeCalendarClient()
    const slots = await findFreeSlots(cal, {
      timeMinIso: input.time_min_iso,
      timeMaxIso: input.time_max_iso,
      minDurationMinutes: input.duration_minutes,
    })
    return {
      count: slots.length,
      slots: slots.map((s) => ({
        start_iso: s.startIso,
        end_iso: s.endIso,
        duration_minutes: s.durationMinutes,
      })),
    }
  },
}
