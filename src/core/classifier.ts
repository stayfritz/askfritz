import { z } from 'zod'
import { ask } from '../integrations/llm/client.js'
import { config } from '../lib/config.js'
import { db } from '../integrations/postgres/db.js'
import { persons } from '../integrations/postgres/schema.js'

export interface ClassificationInput {
  from: { name?: string | undefined; email: string }
  to: string[]
  cc: string[]
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
  doc_type: z
    .enum([
      'invoice',
      'receipt',
      'contract',
      'statement',
      'newsletter',
      'personal',
      'notification',
      'other',
    ])
    .nullable(),
  suggested_action: z.enum(['reply', 'forward', 'none']),
  suggested_forward_to: z.string().nullable(),
})

export type Classification = z.infer<typeof classificationSchema>

async function buildSystemPrompt(): Promise<string> {
  const knownDomains = config.domains.domains
    .map(
      (d) =>
        `- id: ${d.id} | name: ${d.name} | language: ${d.default_language} | description: ${d.description?.replace(/\n/g, ' ').trim() ?? '(none)'}`,
    )
    .join('\n')

  // Load from DB so runtime-added persons (via Telegram /Anlegen-Button or
  // lifestate_upsert_person tool) become visible to the classifier immediately.
  const dbPersons = await db.select().from(persons)
  const knownPersons = dbPersons
    .map((p) => {
      const emails = (p.emails ?? []).join(', ') || '(none)'
      return `- id: ${p.id} | name: ${p.name} | domain: ${p.domainId} | role: ${p.role ?? '?'} | emails: ${emails} | lang: ${p.language ?? '?'}`
    })
    .join('\n')

  const forwardingRules =
    config.policies.forwarding_rules.length === 0
      ? '(none configured)'
      : config.policies.forwarding_rules
          .map(
            (r) =>
              `- doc_type=${r.doc_type} → forward_to=${r.forward_to}` +
              (r.description ? `\n  trigger: ${r.description.replace(/\s+/g, ' ').trim()}` : ''),
          )
          .join('\n')

  return `You are an email-triage classifier for askfritz, a personal AI chief-of-staff for Thomas Langenberg.

Your job: classify each inbound email into a known life-domain, suggest a topic, match the sender if possible, assess intent/urgency, and decide whether the mail should be replied to, forwarded to a routing inbox, or left alone. Output strict JSON only.

THOMAS' PRIMARY EMAIL: ${config.system.email.primary}

KNOWN DOMAINS:
${knownDomains}

KNOWN PERSONS (sender candidates):
${knownPersons}

FORWARDING ROUTES (doc_type → target inbox):
${forwardingRules}

RULES:
- domain_id: pick the matching domain id, or null if uncertain. When null, the email is flagged for human review.
- topic_hint: short snake_case slug suggesting the topic (e.g. "krankenversicherung_es_kinder", "steuer_2025_q1", "geschaeftskonto_setup"). Used to fuzzy-match or create topics. Null if unclear.
- sender_person_id: if the From email matches one of the known persons' emails, set their id. Otherwise null (= new contact, will be reviewed).
- intent: "query" (asks for info), "fyi" (informational update), "action_required" (Thomas must decide or reply), or "unknown". WICHTIG zur CC-Erkennung: wenn Thomas' Primary-Email nur in CC steht und NICHT in TO, dann ist intent fast immer "fyi" — der Mail-Absender hat Thomas nur informiert, die eigentliche Aktion liegt beim TO-Empfänger. Nur wenn der Body explizit Thomas direkt anspricht oder eine Frage stellt ("Thomas, kannst du …?", "@Thomas"), dann darf intent="action_required" sein, auch bei reinem CC.
- urgency: "high" (time-critical or money/legal/health), "med" (normal), "low" (can wait).
- language: ISO 639-1 code of the email body (de, en, es).
- summary: 1-2 sentence German summary of what the email is about and what (if anything) is expected from Thomas.
- doc_type: classify the document character. WICHTIG: doc_type ist UNABHÄNGIG von intent. Eine Rechnung von Anthropic ist doc_type=invoice, auch wenn keine Antwort nötig ist (intent=fyi). Setze doc_type nur dann auf null, wenn du wirklich keine der Kategorien zuordnen kannst.
    * "invoice"     — Rechnung/Quittung/Receipt mit PDF-Anhang von einem Billing-System (Anthropic, Stripe, AWS, Hetzner, Coolify, Vercel, Google Workspace, OpenAI, …) ODER Subject enthält "invoice/receipt/rechnung/quittung/beleg/Your receipt from …". Hat fast immer eine Rechnungs-Nummer im Subject.
    * "receipt"     — Zahlungsbestätigung ohne separaten Rechnungs-Anhang (z.B. "Your payment was successful", Stripe-Charge-Confirmation).
    * "contract"    — Vertragsdokument, AGB-Update, Kündigung.
    * "statement"   — Kontoauszug, Reporting.
    * "newsletter"  — Marketing/Newsletter.
    * "personal"    — private Mail von Bekannten/Familie.
    * "notification"— System-Notification ohne Aktion (Deployment-OK, GitHub PR-Notice, …).
    * "other"       — alles andere.
    * null nur wenn wirklich nichts passt.
- suggested_action: WÄHLE IN DIESER REIHENFOLGE (forward hat absolute Priorität):
    1. "forward" — IMMER wenn doc_type zu einer der FORWARDING ROUTES oben passt. Das gilt AUCH wenn intent=fyi oder notification. Eine Rechnung ist doc_type=invoice → suggested_action=forward, fertig. NUR Targets aus der Liste oben verwenden. Niemals erfundene Adressen.
    2. "reply" — wenn keine Route greift UND intent="action_required".
    3. "none" — sonst (echtes FYI ohne Routing, Newsletter, …).
- suggested_forward_to: bei "forward" die EXAKTE Target-Email aus der Liste oben. Sonst null.

OUTPUT: a single JSON object, no markdown fences, no prose.

Schema:
{
  "domain_id": string | null,
  "topic_hint": string | null,
  "sender_person_id": string | null,
  "intent": "query" | "fyi" | "action_required" | "unknown",
  "urgency": "low" | "med" | "high",
  "language": string,
  "summary": string,
  "doc_type": "invoice" | "receipt" | "contract" | "statement" | "newsletter" | "personal" | "notification" | "other" | null,
  "suggested_action": "reply" | "forward" | "none",
  "suggested_forward_to": string | null
}`
}

const MAX_BODY_CHARS = 4000

export async function classify(
  input: ClassificationInput,
): Promise<Classification> {
  const system = await buildSystemPrompt()

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

  const primary = config.system.email.primary.toLowerCase()
  const isInTo = input.to.some((addr) => addr.toLowerCase().includes(primary))
  const isInCc = input.cc.some((addr) => addr.toLowerCase().includes(primary))
  const recipientNote = !isInTo && isInCc
    ? '\nNOTE: Thomas ist nur CC, NICHT TO. Default ist intent=fyi außer der Body spricht ihn explizit an.'
    : ''

  const userPrompt = `Classify this email. Respond with only the JSON object.

FROM: ${fromLine}
TO:   ${input.to.length ? input.to.join(', ') : '(none)'}
CC:   ${input.cc.length ? input.cc.join(', ') : '(none)'}${recipientNote}
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
