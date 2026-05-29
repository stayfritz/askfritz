import { z } from 'zod'
import { ask } from '../integrations/llm/client.js'
import { config } from '../lib/config.js'

export interface ClassificationInput {
  from: { name?: string | undefined; email: string }
  subject: string
  bodyText: string
  attachments: Array<{ filename: string; mimeType: string }>
}

const classificationSchema = z.object({
  domain_id: z.string().nullable(),
  topic_hint: z.string().nullable(),
  sender_person_id: z.string().nullable(),
  intent: z.enum(['query', 'fyi', 'action_required', 'unknown']),
  urgency: z.enum(['low', 'med', 'high']),
  language: z.string(),
  summary: z.string(),
})

export type Classification = z.infer<typeof classificationSchema>

function buildSystemPrompt(): string {
  const knownDomains = config.domains.domains
    .map(
      (d) =>
        `- id: ${d.id} | name: ${d.name} | language: ${d.default_language} | description: ${d.description?.replace(/\n/g, ' ').trim() ?? '(none)'}`,
    )
    .join('\n')

  const knownPersons = config.persons.persons
    .map((p) => {
      const emails = (p.emails ?? []).join(', ') || '(none)'
      return `- id: ${p.id} | name: ${p.name} | domain: ${p.domain_id} | role: ${p.role ?? '?'} | emails: ${emails} | lang: ${p.language ?? '?'}`
    })
    .join('\n')

  return `You are an email-triage classifier for askfritz, a personal AI chief-of-staff for Thomas Langenberg.

Your job: classify each inbound email into a known life-domain, suggest a topic, match the sender if possible, and assess intent/urgency. Output strict JSON only.

KNOWN DOMAINS:
${knownDomains}

KNOWN PERSONS (sender candidates):
${knownPersons}

RULES:
- domain_id: pick the matching domain id, or null if uncertain. When null, the email is flagged for human review.
- topic_hint: short snake_case slug suggesting the topic (e.g. "krankenversicherung_es_kinder", "steuer_2025_q1", "geschaeftskonto_setup"). Used to fuzzy-match or create topics. Null if unclear.
- sender_person_id: if the From email matches one of the known persons' emails, set their id. Otherwise null (= new contact, will be reviewed).
- intent: "query" (asks for info), "fyi" (informational update), "action_required" (Thomas must decide or reply), or "unknown".
- urgency: "high" (time-critical or money/legal/health), "med" (normal), "low" (can wait).
- language: ISO 639-1 code of the email body (de, en, es).
- summary: 1-2 sentence German summary of what the email is about and what (if anything) is expected from Thomas.

OUTPUT: a single JSON object, no markdown fences, no prose.

Schema:
{
  "domain_id": string | null,
  "topic_hint": string | null,
  "sender_person_id": string | null,
  "intent": "query" | "fyi" | "action_required" | "unknown",
  "urgency": "low" | "med" | "high",
  "language": string,
  "summary": string
}`
}

const MAX_BODY_CHARS = 4000

export async function classify(
  input: ClassificationInput,
): Promise<Classification> {
  const system = buildSystemPrompt()

  const truncatedBody =
    input.bodyText.length > MAX_BODY_CHARS
      ? input.bodyText.slice(0, MAX_BODY_CHARS) + '\n[...truncated]'
      : input.bodyText

  const fromLine = input.from.name
    ? `${input.from.name} <${input.from.email}>`
    : input.from.email

  const attachmentsLine =
    input.attachments.length === 0
      ? '(none)'
      : input.attachments
          .map((a) => `- ${a.filename} (${a.mimeType})`)
          .join('\n')

  const userPrompt = `Classify this email. Respond with only the JSON object.

FROM: ${fromLine}
SUBJECT: ${input.subject}

BODY:
${truncatedBody}

ATTACHMENTS:
${attachmentsLine}`

  const raw = await ask(userPrompt, {
    tier: 'classifier',
    system,
    cacheSystem: true,
    maxTokens: 512,
    temperature: 0,
  })

  return parseClassificationResponse(raw)
}

function parseClassificationResponse(raw: string): Classification {
  let jsonText = raw.trim()
  // Strip markdown fences if model adds them despite instruction
  if (jsonText.startsWith('```')) {
    jsonText = jsonText
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim()
  }
  const parsed = JSON.parse(jsonText) as unknown
  return classificationSchema.parse(parsed)
}
