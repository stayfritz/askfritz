import type { AnyTool } from './types.js'
import {
  gmailArchiveMatching,
  gmailFilterCreate,
  gmailGetMessage,
  gmailSearchMessages,
  gmailUnsubscribe,
} from './gmail.js'
import {
  lifestateTaskDone,
  lifestateTaskSnooze,
  lifestateTopicDone,
} from './lifestate.js'

export const allTools: AnyTool[] = [
  gmailSearchMessages,
  gmailGetMessage,
  gmailFilterCreate,
  gmailArchiveMatching,
  gmailUnsubscribe,
  lifestateTaskDone,
  lifestateTaskSnooze,
  lifestateTopicDone,
]

export function findTool(name: string): AnyTool | undefined {
  return allTools.find((t) => t.name === name)
}
