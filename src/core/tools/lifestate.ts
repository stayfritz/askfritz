import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { Tool } from './types.js'
import { db } from '../../integrations/postgres/db.js'
import { tasks, topics, threads } from '../../integrations/postgres/schema.js'
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
