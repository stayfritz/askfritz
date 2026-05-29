import { desc, eq } from 'drizzle-orm'
import { db } from '../integrations/postgres/db.js'
import {
  documents,
  persons,
  tasks,
  topics,
} from '../integrations/postgres/schema.js'
import { ask } from '../integrations/llm/client.js'

const SYSTEM_PROMPT = `Du bist Fritz, Thomas Langenbergs persönlicher AI-Stabschef.

Über Thomas:
- Lebt zwischen Deutschland und Spanien, gründet aktuell die StayFritz Spain SL
- Frau: Kerstin Langenberg
- Aktuell laufende Themen: Wegzug nach Spanien, spanische Krankenversicherung, Steuer (mit Stb Jochen), Versicherungen/Ummeldungen (mit Anke Svenester)

Deine Aufgabe:
- Beantworte Thomas' Fragen kurz, präzise, auf Deutsch
- Stütze dich auf den unten gelieferten Life State (Topics, Tasks, Documents)
- Wenn du keine Information findest, sag das direkt — rate nicht
- Wenn du Aktionen vorschlägst, formuliere konkret
- Zitiere Quellen mit Datum wenn relevant (z.B. "Laut Mail vom 23.5. ...")
- Antworten max. 5 Sätze, außer die Frage braucht mehr`

const MAX_DOCS_IN_CONTEXT = 30
const MAX_SUMMARY_CHARS = 400

export async function answerQuery(question: string): Promise<string> {
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

  const personsBlock = knownPersons
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
            t.ownerPersonId ? personIndex.get(t.ownerPersonId) ?? t.ownerPersonId : '?'
          }`,
      )
      .join('\n') || '(keine offen)'

  const tasksBlock =
    pendingTasks
      .map((t, i) => `${i + 1}. [topic: ${t.topicId ?? '?'}] ${t.description}`)
      .join('\n') || '(keine pending)'

  const docsBlock =
    recentDocs
      .map((d) => {
        const date = d.receivedAt.toISOString().slice(0, 10)
        const summary =
          (d.summary ?? '').length > MAX_SUMMARY_CHARS
            ? (d.summary ?? '').slice(0, MAX_SUMMARY_CHARS) + '...'
            : (d.summary ?? '')
        return `- ${date} | topic: ${d.topicId ?? '?'} | ${summary}`
      })
      .join('\n') || '(keine Documents)'

  const userPrompt = `LIFE STATE (Stand ${new Date().toISOString()}):

BEKANNTE KONTAKTE:
${personsBlock}

OFFENE TOPICS:
${topicsBlock}

PENDING-USER TASKS:
${tasksBlock}

LETZTE ${MAX_DOCS_IN_CONTEXT} DOCUMENTS (neueste zuerst):
${docsBlock}

---

FRAGE VON THOMAS:
${question}

Antworte auf Deutsch, kurz und konkret.`

  return await ask(userPrompt, {
    tier: 'default',
    system: SYSTEM_PROMPT,
    cacheSystem: true,
    maxTokens: 1024,
  })
}
