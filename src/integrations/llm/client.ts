import Anthropic from '@anthropic-ai/sdk'
import { config } from '../../lib/config.js'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  throw new Error('ANTHROPIC_API_KEY env var not set')
}

export const anthropic = new Anthropic({ apiKey })

export type ModelTier = 'classifier' | 'default' | 'heavy'

export function modelFor(tier: ModelTier): string {
  switch (tier) {
    case 'classifier':
      return config.system.llm.classifier_model
    case 'default':
      return config.system.llm.default_model
    case 'heavy':
      return config.system.llm.heavy_model
  }
}

export interface AskOptions {
  tier?: ModelTier
  system?: string
  /** Mark system prompt as cacheable (ephemeral, 5min TTL). */
  cacheSystem?: boolean
  maxTokens?: number
  temperature?: number
}

/**
 * One-shot completion. Returns the text of the first content block.
 * Throws if the model returned something other than text (tool use etc.).
 */
export async function ask(
  prompt: string,
  opts: AskOptions = {},
): Promise<string> {
  const model = modelFor(opts.tier ?? 'default')

  const systemParam = opts.system
    ? opts.cacheSystem
      ? [
          {
            type: 'text' as const,
            text: opts.system,
            cache_control: { type: 'ephemeral' as const },
          },
        ]
      : opts.system
    : undefined

  const response = await anthropic.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature,
    system: systemParam,
    messages: [{ role: 'user', content: prompt }],
  })

  const block = response.content[0]
  if (!block || block.type !== 'text') {
    throw new Error(
      `Expected text response from Claude, got ${block?.type ?? 'none'}`,
    )
  }
  return block.text
}
