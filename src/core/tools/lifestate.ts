import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Tool } from './types.js'
import { db } from '../../integrations/postgres/db.js'
import {
  persons,
  tasks,
  topics,
  threads,
} from '../../integrations/postgres/schema.js'
import { logger } from '../../lib/logger.js'

// ---------------------------------------------------------------------------
// lifestate_task_done
// ---------------------------------------------------------------------------

const taskDoneInput = z.object({
  task_id: z
    .string()
    .uuid()
    .describe('UUID of the task to mark as done.'),
})

export const lifestateTaskDone: Tool<
  z.infer<typeof taskDoneInput>,
  { ok: boolean; reason?: string }
> = {
  name: 'lifestate_task_done',
  description:
    'Mark a pending task as done (e.g. Thomas handled it offline, no mail needed).',
  inputSchema: taskDoneInput,
  execute: async (input) => {
    const result = await db
      .update(tasks)
      .set({ status: 'done', updatedAt: new Date() })
      .where(eq(tasks.id, input.task_id))
      .returning({ id: tasks.id })
    if (result.length === 0) {
      return { ok: false, reason: 'task not found' }
    }
    logger.info({ taskId: input.task_id }, 'task marked done by user')
    return { ok: true }
  },
}

// ---------------------------------------------------------------------------
// lifestate_task_snooze
// ---------------------------------------------------------------------------

const taskSnoozeInput = z.object({
  task_id: z.string().uuid(),
  until: z
    .string()
    .datetime({ offset: true })
    .describe(
      'ISO 8601 datetime with timezone (e.g. "2026-06-15T08:00:00+02:00") when the task should resurface.',
    ),
})

export const lifestateTaskSnooze: Tool<
  z.infer<typeof taskSnoozeInput>,
  { ok: boolean; reason?: string }
> = {
  name: 'lifestate_task_snooze',
  description:
    'Snooze a task: move it to "snoozed" status with a due_at datetime so it stays out of the active queue until then.',
  inputSchema: taskSnoozeInput,
  execute: async (input) => {
    const result = await db
      .update(tasks)
      .set({
        status: 'snoozed',
        dueAt: new Date(input.until),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, input.task_id))
      .returning({ id: tasks.id })
    if (result.length === 0) {
      return { ok: false, reason: 'task not found' }
    }
    logger.info(
      { taskId: input.task_id, until: input.until },
      'task snoozed',
    )
    return { ok: true }
  },
}

// ---------------------------------------------------------------------------
// lifestate_topic_done
// ---------------------------------------------------------------------------

const topicDoneInput = z.object({
  topic_id: z.string(),
})

export const lifestateTopicDone: Tool<
  z.infer<typeof topicDoneInput>,
  { ok: boolean; reason?: string }
> = {
  name: 'lifestate_topic_done',
  description:
    'Mark an entire topic as done. Also closes any open threads linked to the topic.',
  inputSchema: topicDoneInput,
  execute: async (input) => {
    const updated = await db
      .update(topics)
      .set({ status: 'done', updatedAt: new Date() })
      .where(eq(topics.id, input.topic_id))
      .returning({ id: topics.id })
    if (updated.length === 0) {
      return { ok: false, reason: 'topic not found' }
    }
    await db
      .update(threads)
      .set({ status: 'closed', updatedAt: new Date() })
      .where(eq(threads.topicId, input.topic_id))
    logger.info({ topicId: input.topic_id }, 'topic marked done')
    return { ok: true }
  },
}

// ---------------------------------------------------------------------------
// lifestate_upsert_person
// ---------------------------------------------------------------------------

const upsertPersonInput = z.object({
  email: z
    .string()
    .email()
    .describe('Email-Adresse der Person — Match-Key für Upsert.'),
  name: z
    .string()
    .min(1)
    .describe('Voller Name, wie er in Mails auftaucht.'),
  role: z
    .string()
    .min(2)
    .describe(
      'Snake_case Rolle: banker, tax_advisor, insurance_admin, lawyer, family, friend, business, vermieter, arzt, … — Notify-Regeln in policies.yaml referenzieren diese Werte.',
    ),
  domain_id: z
    .string()
    .describe(
      'Bestehende domain id (z.B. "stayfritz_spain", "privat"). Pflicht, sonst kann die Person nicht in einem Lebensbereich verankert werden.',
    ),
  language: z
    .string()
    .optional()
    .describe('ISO 639-1 Sprachcode (de, en, es). Default: de.'),
})

export const lifestateUpsertPerson: Tool<
  z.infer<typeof upsertPersonInput>,
  { ok: boolean; person_id?: string; created?: boolean; reason?: string }
> = {
  name: 'lifestate_upsert_person',
  description:
    'Lege eine neue Person an oder update eine bestehende anhand der Email-Adresse. Nutze das, wenn Thomas dir mitteilt, dass jemand eine bestimmte Rolle hat ("X ist mein Y", "Z ist meine Steuerberaterin"). Match per Email; wenn schon vorhanden, wird Rolle/Domain überschrieben. Zukünftige Mails von dieser Email werden vom Classifier automatisch dieser Person zugeordnet, und notify_fyi-Regeln in policies.yaml können nach role matchen.',
  inputSchema: upsertPersonInput,
  execute: async (input) => {
    const all = await db.select().from(persons)
    const existing = all.find((p) =>
      p.emails?.some((e) => e.toLowerCase() === input.email.toLowerCase()),
    )
    if (existing) {
      await db
        .update(persons)
        .set({
          role: input.role,
          domainId: input.domain_id,
          name: input.name,
          language: input.language ?? existing.language,
          updatedAt: new Date(),
        })
        .where(eq(persons.id, existing.id))
      logger.info(
        { personId: existing.id, role: input.role },
        'person updated via tool',
      )
      return { ok: true, person_id: existing.id, created: false }
    }
    const base = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40)
    let id = base || 'person'
    let n = 2
    while (all.some((p) => p.id === id)) {
      id = `${base}_${n++}`
    }
    await db.insert(persons).values({
      id,
      domainId: input.domain_id,
      name: input.name,
      role: input.role,
      emails: [input.email],
      phones: [],
      language: input.language ?? 'de',
    })
    logger.info({ personId: id, role: input.role }, 'person created via tool')
    return { ok: true, person_id: id, created: true }
  },
}
