import type { z } from 'zod'

export interface ToolContext {
  /** Telegram user id of the requester (allowed user). */
  userId: number
}

/**
 * `TInput` is the OUTPUT type of the schema (after `.default()` etc. applied).
 * Third generic of ZodType is the raw input — left as `any` so schemas with
 * defaults stay assignable.
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, any>
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>
}

export type AnyTool = Tool<any, any>
