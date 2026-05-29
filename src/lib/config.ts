import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

const CONFIG_DIR = resolve(process.cwd(), 'config')

const systemSchema = z.object({
  language: z.object({ default: z.string() }),
  timezone: z.string(),
  dropbox: z.object({ root: z.string() }),
  email: z.object({
    primary: z.string().email(),
    signature: z.string(),
  }),
  llm: z.object({
    classifier_model: z.string(),
    default_model: z.string(),
    heavy_model: z.string(),
  }),
})

const domainsSchema = z.object({
  domains: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      default_language: z.string().default('de'),
    }),
  ),
})

const personsSchema = z.object({
  persons: z.array(
    z.object({
      id: z.string(),
      domain_id: z.string(),
      name: z.string(),
      role: z.string().optional(),
      emails: z.array(z.string()).default([]),
      phones: z.array(z.string()).default([]),
      language: z.string().optional(),
      notes: z.string().optional(),
    }),
  ),
})

const policySchema = z.object({
  inherit: z.string().optional(),
  require_approval: z.array(z.string()).default([]),
  allow_auto: z.array(z.string()).default([]),
})

const policiesSchema = z.object({
  policies: z.record(z.string(), policySchema),
})

const routingSchema = z.object({
  inbound: z.object({
    email: z.record(
      z.string(),
      z.object({
        default_domain: z.string().nullable(),
        classification_hint: z.string(),
      }),
    ),
  }),
})

function loadYaml<T>(name: string, schema: z.ZodType<T>): T {
  const path = resolve(CONFIG_DIR, name)
  const content = readFileSync(path, 'utf-8')
  const parsed = parse(content)
  return schema.parse(parsed)
}

export const config = {
  system: loadYaml('system.yaml', systemSchema),
  domains: loadYaml('domains.yaml', domainsSchema),
  persons: loadYaml('persons.yaml', personsSchema),
  policies: loadYaml('policies.yaml', policiesSchema),
  routing: loadYaml('routing.yaml', routingSchema),
}

export type Config = typeof config
export type SystemConfig = Config['system']
export type Person = Config['persons']['persons'][number]
export type Domain = Config['domains']['domains'][number]
export type Policy = z.infer<typeof policySchema>
