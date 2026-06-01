import type { AnyTool } from './types.js'
import {
  gmailArchiveMatching,
  gmailDraftReply,
  gmailFilterCreate,
  gmailGetMessage,
  gmailSearchMessages,
  gmailUnsubscribe,
} from './gmail.js'
import {
  lifestateTaskDone,
  lifestateTaskSnooze,
  lifestateTopicDone,
  lifestateUpsertPerson,
} from './lifestate.js'
import {
  calendarFindFreeSlot,
  calendarListEvents,
  calendarProposeEvent,
} from './calendar.js'

export const allTools: AnyTool[] = [
  gmailSearchMessages,
  gmailGetMessage,
  gmailDraftReply,
  gmailFilterCreate,
  gmailArchiveMatching,
  gmailUnsubscribe,
  calendarListEvents,
  calendarFindFreeSlot,
  calendarProposeEvent,
  lifestateTaskDone,
  lifestateTaskSnooze,
  lifestateTopicDone,
  lifestateUpsertPerson,
]

export function findTool(name: string): AnyTool | undefined {
  return allTools.find((t) => t.name === name)
}
