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
import {
  getConversation,
  saveConversation,
} from '../lib/conversation-store.js'

const STATIC_SYSTEM = `Du bist Fritz, Thomas Langenbergs persönlicher AI-Stabschef.

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
- lifestate_task_snooze: Task auf später schieben (mit ISO Datetime, Europe/Berlin)
- lifestate_topic_done: Topic abschließen (markiert auch verlinkte Threads als closed)

Verhalten:
- Wenn Thomas eine Aktion will, NUTZE die Tools direkt. Frag nicht erst "soll ich" — mach es, dann melde Ergebnis.
- Bei JEDEM Zeitbezug ("heute", "gestern", "seit gestern Abend", "diese Woche", "letzte Woche", "die letzten N Tage/Stunden/Wochen", "neulich", "kürzlich", "Wochenende") IMMER ZUERST gmail_search_messages mit "newer_than:Nd" (oder "after:UNIX_TS") aufrufen. Der Life State unten zeigt nur einen kuratierten Auszug, nicht alles. Verlasse dich NIEMALS allein darauf, wenn die Frage einen Zeitraum nennt.
- Wenn der Life State unten einen Hinweis wie "(+N weitere ähnliche Alerts)" enthält, dann WURDEN Mails komprimiert — bei Detail-Fragen ggf. gmail_search_messages nutzen, um den vollen Stand zu sehen.
- Bei "filter X weg" oder "weniger Mails von Y": kombiniere gmail_filter_create + gmail_archive_matching, damit auch bestehende Mails verschwinden.
- Bei Newsletter-Abmeldung: erst gmail_search_messages für eine konkrete message_id, dann gmail_unsubscribe.
- Wenn Thomas im Folge-Turn auf jemand/etwas aus deiner vorherigen Antwort verweist (z.B. "danke Jessica"), nutze deinen Konversations-Verlauf (siehst du als vorherige messages) und ggf. gmail_search_messages, um die nötigen Details zu holen.
- Antworte am Ende kurz, konkret, auf Deutsch. Was hast du gemacht, was ist das Ergebnis.
- Wenn ein Tool fehlt für das was Thomas will: sag das ehrlich + schlag konkret vor, was er manuell tun kann.

Bei reinen Fragen ohne Aktion antworte aus dem Life State unten + Konversations-Verlauf — keine Tools nötig, außer bei zeitlichen Bezügen.

Max 5 Sätze in der finalen Antwort, außer die Antwort braucht eine Liste.`

const MAX_DOCS_IN_CONTEXT = 30
const MAX_SUMMARY_CHARS = 400

/**
 * Some senders flood the inbox with near-identical subjects (production
 * monitoring alerts, daily-digest mails). Without collapsing, the most-recent
 * 30 docs become 30 worker-stall alerts and everything else is invisible.
 * We collapse by subject-prefix into one representative + "+N more".
 */
function dedupNoisyDocs<
  D extends { receivedAt: Date; originalSubject: string | null },
>(docs: D[]): Array<D & { _dupCount: number }> {
  const stripped = (s: string | null): string =>
    (s ?? '')
      .replace(/^(Re|AW|Fwd|WG):\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .toLowerCase()

  const groups = new Map<string, D[]>()
  for (const d of docs) {
    const key = stripped(d.originalSubject)
    if (!key) {
      groups.set(`__nokey__${d.receivedAt.toISOString()}`, [d])
      continue
    }
    const arr = groups.get(key) ?? []
    arr.push(d)
    groups.set(key, arr)
  }

  const out: Array<D & { _dupCount: number }> = []
  for (const arr of groups.values()) {
    const newest = arr.reduce((a, b) =>
      a.receivedAt > b.receivedAt ? a : b,
    )
    out.push({ ...newest, _dupCount: arr.length - 1 })
  }
  out.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
  return out
}

function formatBerlinTime(d: Date): string {
  return d.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function buildLifeStateBlock(): Promise<string> {
  const [openTopics, pendingTasks, recentDocs, knownPersons] =
    await Promise.all([
      db.select().from(topics).where(eq(topics.status, 'in_progress')),
      db.select().from(tasks).where(eq(tasks.status, 'pending_user')),
      db
        .select()
        .from(documents)
        .orderBy(desc(documents.receivedAt))
        .limit(MAX_DOCS_IN_CONTEXT * 6),
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

  const deduped = dedupNoisyDocs(recentDocs).slice(0, MAX_DOCS_IN_CONTEXT)
  const droppedCount = recentDocs.length - deduped.length
  const droppedHint =
    droppedCount > 0
      ? `\n(zusätzlich ${droppedCount} weitere Mails im 4-Tages-Fenster — bei spezifischen Fragen gmail_search_messages nutzen.)`
      : ''

  const docsBlock =
    deduped
      .map((d) => {
        const date = d.receivedAt.toISOString().slice(0, 10)
        const summary =
          (d.summary ?? '').length > MAX_SUMMARY_CHARS
            ? (d.summary ?? '').slice(0, MAX_SUMMARY_CHARS) + '...'
            : (d.summary ?? '')
        const dupSuffix =
          d._dupCount > 0 ? ` (+${d._dupCount} weitere ähnliche)` : ''
        return `- ${date} | doc_id: ${d.id.slice(0, 8)} | topic: ${d.topicId ?? '?'} | ${summary}${dupSuffix}`
      })
      .join('\n') || '(keine Documents)'

  return `BEKANNTE KONTAKTE:
${personsBlock}

OFFENE TOPICS:
${topicsBlock}

PENDING-USER TASKS (task_id ist UUID, brauchst du für lifestate_task_* Tools):
${tasksBlock}

LETZTE DOCUMENTS (top ${MAX_DOCS_IN_CONTEXT}, ähnliche zusammengefasst):
${docsBlock}${droppedHint}`
}

export async function answerQuery(
  question: string,
  ctx: ToolContext,
): Promise<string> {
  const now = new Date()
  const nowBerlin = formatBerlinTime(now)
  const nowIso = now.toISOString()

  const lifeStateBlock = await buildLifeStateBlock()

  const systemPrompt = `${STATIC_SYSTEM}

HEUTE: ${nowBerlin} (ISO ${nowIso}, Europe/Berlin).
Wenn Thomas "gestern", "letzte Woche" o.ä. sagt, beziehe dich auf DIESES Datum.

AKTUELLER LIFE STATE:
${lifeStateBlock}`

  const history = getConversation(ctx.userId)
  const result = await runAgent(question, systemPrompt, history, ctx)
  saveConversation(ctx.userId, result.finalMessages)
  return result.text
}
