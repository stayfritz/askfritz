import type Anthropic from '@anthropic-ai/sdk'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { anthropic, modelFor } from '../integrations/llm/client.js'
import { allTools, findTool } from './tools/registry.js'
import type { ToolContext } from './tools/types.js'
import { logger } from '../lib/logger.js'

const MAX_ITERATIONS = 8

function toAnthropicTool(
  t: (typeof allTools)[number],
): Anthropic.Tool {
  const schema = zodToJsonSchema(t.inputSchema, {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as Anthropic.Tool['input_schema']
  return {
    name: t.name,
    description: t.description,
    input_schema: schema,
  }
}

export interface AgentResult {
  text: string
  iterations: number
  toolCalls: Array<{ name: string; input: unknown; ok: boolean }>
}

export async function runAgent(
  userPrompt: string,
  systemPrompt: string,
  ctx: ToolContext,
): Promise<AgentResult> {
  const tools = allTools.map(toAnthropicTool)
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ]
  const toolCalls: AgentResult['toolCalls'] = []

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: modelFor('default'),
      max_tokens: 2048,
      system: systemPrompt,
      tools,
      messages,
    })

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      )
      return {
        text: textBlock?.text ?? '',
        iterations: i + 1,
        toolCalls,
      }
    }

    if (response.stop_reason !== 'tool_use') {
      logger.warn(
        { stopReason: response.stop_reason },
        'agent stopped for unexpected reason',
      )
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      )
      return {
        text: textBlock?.text ?? '(Agent stopped without final response.)',
        iterations: i + 1,
        toolCalls,
      }
    }

    messages.push({ role: 'assistant', content: response.content })

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )

    const toolResults: Anthropic.ToolResultBlockParam[] = []

    for (const toolUse of toolUseBlocks) {
      const tool = findTool(toolUse.name)
      let resultContent: string
      let isError = false
      let ok = false

      if (!tool) {
        resultContent = JSON.stringify({
          error: `Unknown tool: ${toolUse.name}`,
        })
        isError = true
      } else {
        try {
          const parsed = tool.inputSchema.parse(toolUse.input)
          const output = await tool.execute(parsed, ctx)
          resultContent = JSON.stringify(output)
          ok = true
        } catch (err) {
          resultContent = JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          })
          isError = true
        }
      }

      toolCalls.push({ name: toolUse.name, input: toolUse.input, ok })
      logger.info(
        { tool: toolUse.name, input: toolUse.input, ok },
        'agent tool call',
      )

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: resultContent,
        is_error: isError,
      })
    }

    messages.push({ role: 'user', content: toolResults })
  }

  return {
    text: '(Agent reached max iterations without finalizing.)',
    iterations: MAX_ITERATIONS,
    toolCalls,
  }
}
