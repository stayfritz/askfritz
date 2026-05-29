import { ask } from '../integrations/llm/client.js'

export interface DraftInput {
  originalFrom: { name?: string | undefined; email: string }
  originalSubject: string
  originalBody: string
  language: string
  summary: string
  /** Optional user-provided edit instructions for re-drafting. */
  editInstructions?: string
  /** Previous draft (when redoing after edit instructions). */
  previousDraft?: string
}

const SYSTEM_PROMPT = `Du schreibst E-Mails im Namen von Thomas Langenberg.

Stil-Regeln:
- Kurz, höflich, präzise. Maximal 5-7 Sätze.
- Antwort-Sprache = Sprache der Original-Mail (Deutsch, Englisch, Spanisch, ...). NICHT die Sprache der Edit-Instructions.
- Sachlich, freundlich, natürlich klingend — niemals förmlich-steif.
- KEINE Email-Signature anhängen (kommt automatisch).
- Bei privaten Mails (Kerstin, Familie, Freunde): Du-Form, Anrede "Hi <Name>", Schluss "LG Thomas" oder "Bis später, Thomas".
- Bei Geschäftskontakten (Stb, Anke, Banker, Versicherungen, Behörden): Sie-Form, Anrede "Hallo Herr/Frau <Nachname>" oder "Guten Tag <Name>", Schluss "Beste Grüße / Saludos / Best regards, Thomas".

Inhaltliche Regeln:
- Beantworte die konkrete Frage. Nichts Unnötiges drumherum.
- Wenn der Sender mehrere Optionen anbietet (Termine etc.), WÄHLE eine plausible aus und schlag sie konkret vor — keine ausweichenden Formulierungen.
- Wenn Informationen fehlen die du nicht hast, frage höflich zurück.
- NIEMALS Tatsachen erfinden (Termine, Zahlen, Zusagen). Wenn unklar → zurückfragen.
- Wenn der Sender eine Aktion erwartet die Thomas nicht klar entscheidet → schreib eine sichere Zwischen-Antwort ("ich melde mich heute Abend dazu" o.ä.).

Output: Nur der Mail-Text. Keine Anführungszeichen, kein Markdown, keine Erklärungen drumherum.`

export async function draftReply(input: DraftInput): Promise<string> {
  const fromLine = input.originalFrom.name
    ? `${input.originalFrom.name} <${input.originalFrom.email}>`
    : input.originalFrom.email

  const editBlock = input.editInstructions
    ? `\n\nDIESER ENTWURF EXISTIERT BEREITS:\n---\n${input.previousDraft ?? '(none)'}\n---\n\nTHOMAS WILL FOLGENDE ÄNDERUNGEN:\n${input.editInstructions}\n\nSchreib den Entwurf neu mit diesen Änderungen.`
    : ''

  const prompt = `Original-Mail:

VON: ${fromLine}
BETREFF: ${input.originalSubject}
SPRACHE: ${input.language}

INHALT:
${input.originalBody.slice(0, 3500)}

ZUSAMMENFASSUNG (was Fritz versteht):
${input.summary}${editBlock}

Schreib den Entwurf für die Antwort.`

  return await ask(prompt, {
    tier: 'default',
    system: SYSTEM_PROMPT,
    cacheSystem: true,
    maxTokens: 1024,
    temperature: 0.3,
  })
}
