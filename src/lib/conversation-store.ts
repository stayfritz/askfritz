import type Anthropic from '@anthropic-ai/sdk'

/**
 * In-memory per-user conversation history for Telegram chats.
 * Stores Anthropic MessageParam arrays so Claude sees prior turns
 * (including tool_use / tool_result exchanges).
 * Lost on process restart — acceptable for v0.
 */

const MAX_USER_TURNS = 8
const conversations = new Map<number, Anthropic.MessageParam[]>()

function isUserTextTurnStart(m: Anthropic.MessageParam): boolean {
  // A "turn" begins with a user message whose content is a plain string
  // (the actual question). User messages with array content are tool_results,
  // which belong to the preceding turn.
  return m.role === 'user' && typeof m.content === 'string'
}

function trimToLastNTurns(
  messages: Anthropic.MessageParam[],
  n: number,
): Anthropic.MessageParam[] {
  const turnStartIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m && isUserTextTurnStart(m)) {
      turnStartIndices.push(i)
    }
  }
  if (turnStartIndices.length <= n) return messages
  const cutAt = turnStartIndices[turnStartIndices.length - n]
  if (cutAt === undefined) return messages
  return messages.slice(cutAt)
}

export function getConversation(userId: number): Anthropic.MessageParam[] {
  return conversations.get(userId) ?? []
}

export function saveConversation(
  userId: number,
  messages: Anthropic.MessageParam[],
): void {
  conversations.set(userId, trimToLastNTurns(messages, MAX_USER_TURNS))
}

export function resetConversation(userId: number): void {
  conversations.delete(userId)
}

export function conversationStats(): {
  users: number
  totalMessages: number
} {
  let total = 0
  for (const msgs of conversations.values()) total += msgs.length
  return { users: conversations.size, totalMessages: total }
}
