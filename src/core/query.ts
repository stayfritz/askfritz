import { desc, eq } from 'drizzle-orm'
import { db } from '../integrations/postgres/db.js'
import {
  documents,
  persons,
  tasks,
  topics,
} from '../integrations/postgres/schema.js'
import { runAgent } from './agent.js'
import type { ToolContext } from './tools/types.js'

const SYSTEM_BASE = `Du bist Fritz, Thomas Langenbergs persönlicher AI-Stabschef.

Über Thomas:
- Lebt zwischen Deutschland und Spanien, gründet aktuell die StayFritz Spain SL
- Frau: Kerstin Langenberg
- Aktuell laufende Themen: Wegzug nach Spanien, spanische Krankenversicherung, Steuer (mit Stb Jochen), Versicherungen/Ummeldungen (mit Anke Svenester)

Du hast Werkzeuge, um Aktionen tatsächlich auszuführen — du musst nicht nur darüber reden:

Gmail-Tools:
- gmail_search_messages: Mails durchsuchen (von / Betreff / Standard-Gmail-Syntax)
- gmail_filter_create: Filter anlegen, der eingehende Mails automatisch sortiert/archiviert
- gmail_archive_matching: Bestehende Mails archivieren, die einer Query matchen
- gmail_unsubscribe: List-Unsubscribe Header benutzen, um sich vom Newsletter abzumelden

Life-State-Tools:
- lifestate_task_done: Task als erledigt markieren
- lifestate_task_snooze: Task auf später schieben (mit ISO Datetime)
- lifestate_topic_done: Topic abschließen (markiert auch verlinkte Threads als closed)

Vorgehen:
- Wenn Thomas eine Aktion will, NUTZE die Tools direkt. Frag nicht erst "soll ich" — mach es, dann melde Ergebnis.
- Wenn du etwas suchen musst (z.B. den Sender eines Alerts), nutze gmail_search_messages.
- Bei "filter X weg" oder "weniger Mails von Y": kombiniere gmail_filter_create + gmail_archive_matching, damit auch bestehende Mails verschwinden.
- Bei Newsletter-Abmeldung: erst gmail_search_messages für eine konkrete message_id, dann gmail_unsubscribe.
- Antworte am Ende kurz, konkret, auf Deutsch. Was hast du gemacht, was ist das Ergebnis.
- Wenn ein Tool fehlt für das was Thomas will: sag das ehrlich + schlag konkret vor, was er manuell tun kann.

Bei reinen Fragen ohne Aktion (z.B. "Was steht beim Stb gerade an?") antworte nur aus dem Life State unten — keine Tools nötig.

Max 5 Sätze in der finalen Antwort, außer die Antwort braucht eine Liste.`

const MAX_DOCS_IN_CONTEXT = 30
const MAX_SUMMARY_CHARS = 400

export async function answerQuery(
  question: string,
  ctx: ToolContext,
): Promise<string> {
  const [openTopics, pendingTasks, recentDocs, knownPersons] =
    await Promise.all([
      db
        .select()
        .from(topics)
        .where(eq(topics.status, 'in_progress')),
      db
        .select()
        .from(tasks)
        .where(eq(tasks.status, 'pending_user')),
      db
        .select()
        .from(documents)
        .orderBy(desc(documents.receivedAt))
        .limit(MAX_DOCS_IN_CONTEXT),
      db.select().from(persons),
    ])

  const personIndex = new Map(knownPersons.map((p) => [p.id, p.name]))

  const personsBlock =
    knownPersons
      .map(
        (p) =>
          `- ${p.id} (${p.name}) | domain: ${p.domainId} | role: ${p.role ?? '?'}`,
      )
      .join('\n') || '(keine konfiguriert)'

  const topicsBlock =
    openTopics
      .map(
        (t) =>
          `- ${t.id} | ${t.name} | priority: ${t.priority} | owner: ${
            t.ownerPersonId
              ? (personIndex.get(t.ownerPersonId) ?? t.ownerPersonId)
              : '?'
          }`,
      )
      .join('\n') || '(keine offen)'

  const tasksBlock =
    pendingTasks
      .map(
        (t) =>
          `- task_id: ${t.id} | topic: ${t.topicId ?? '?'} | ${t.description}`,
      )
      .join('\n') || '(keine pending)'

  const docsBlock =
    recentDocs
      .map((d) => {
        const date = d.receivedAt.toISOString().slice(0, 10)
        const summary =
          (d.summary ?? '').length > MAX_SUMMARY_CHARS
            ? (d.summary ?? '').slice(0, MAX_SUMMARY_CHARS) + '...'
            : (d.summary ?? '')
        return `- ${date} | doc_id: ${d.id.slice(0, 8)} | topic: ${d.topicId ?? '?'} | ${summary}`
      })
      .join('\n') || '(keine Documents)'

  const nowIso = new Date().toISOString()

  const userPrompt = `Stand: ${nowIso}

BEKANNTE KONTAKTE:
${personsBlock}

OFFENE TOPICS:
${topicsBlock}

PENDING-USER TASKS (task_id ist UUID, brauchst du für lifestate_task_* Tools):
${tasksBlock}

LETZTE ${MAX_DOCS_IN_CONTEXT} DOCUMENTS:
${docsBlock}

---

FRAGE / AUFTRAG VON THOMAS:
${question}`

  const result = await runAgent(userPrompt, SYSTEM_BASE, ctx)
  return result.text
}
