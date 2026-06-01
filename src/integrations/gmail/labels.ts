import type { gmail_v1 } from 'googleapis'
import { logger } from '../../lib/logger.js'

/**
 * Fritz' label state machine, visible directly in Gmail.
 * Each ingested mail ends up in exactly one of these states — the labels
 * are mutually exclusive (transitions remove the previous one).
 *
 * Colors use Gmail's fixed palette (only certain hex combos are accepted by
 * the labels.create API; arbitrary colors return 400).
 */
export type FritzState =
  | 'seen' // klassifiziert, keine Aktion nötig
  | 'draft-pending' // Antwort-Entwurf wartet auf Approval
  | 'forward-pending' // Forward-Vorschlag wartet auf Approval
  | 'replied' // Antwort gesendet
  | 'forwarded' // Weitergeleitet
  | 'discarded' // verworfen

interface LabelDef {
  state: FritzState
  name: string
  backgroundColor: string
  textColor: string
}

const FRITZ_LABELS: LabelDef[] = [
  {
    state: 'seen',
    name: 'Fritz/seen',
    backgroundColor: '#cccccc',
    textColor: '#000000',
  },
  {
    state: 'draft-pending',
    name: 'Fritz/draft-pending',
    backgroundColor: '#fad165',
    textColor: '#000000',
  },
  {
    state: 'forward-pending',
    name: 'Fritz/forward-pending',
    backgroundColor: '#ffad47',
    textColor: '#000000',
  },
  {
    state: 'replied',
    name: 'Fritz/replied',
    backgroundColor: '#16a766',
    textColor: '#ffffff',
  },
  {
    state: 'forwarded',
    name: 'Fritz/forwarded',
    backgroundColor: '#16a766',
    textColor: '#ffffff',
  },
  {
    state: 'discarded',
    name: 'Fritz/discarded',
    backgroundColor: '#fb4c2f',
    textColor: '#ffffff',
  },
]

const stateByName = new Map(FRITZ_LABELS.map((d) => [d.name, d.state]))

/** Cache name → labelId, populated on first call per process. */
let labelCache: Map<FritzState, string> | null = null

async function buildCache(
  gmail: gmail_v1.Gmail,
): Promise<Map<FritzState, string>> {
  const { data } = await gmail.users.labels.list({ userId: 'me' })
  const existing = new Map<string, string>()
  for (const l of data.labels ?? []) {
    if (l.name && l.id) existing.set(l.name, l.id)
  }

  const cache = new Map<FritzState, string>()
  for (const def of FRITZ_LABELS) {
    let id = existing.get(def.name)
    if (!id) {
      try {
        const created = await gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name: def.name,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
            color: {
              backgroundColor: def.backgroundColor,
              textColor: def.textColor,
            },
          },
        })
        id = created.data.id ?? undefined
        if (id) {
          logger.info(
            { label: def.name, id, color: def.backgroundColor },
            'fritz label created',
          )
        }
      } catch (err) {
        logger.error(
          { err, label: def.name },
          'failed to create fritz label — color may be invalid for Gmail palette',
        )
      }
    }
    if (id) cache.set(def.state, id)
  }
  return cache
}

export async function ensureFritzLabels(
  gmail: gmail_v1.Gmail,
): Promise<Map<FritzState, string>> {
  if (labelCache) return labelCache
  labelCache = await buildCache(gmail)
  return labelCache
}

/**
 * Set a single Fritz state on a Gmail message. Removes any other Fritz/*
 * labels first so states are mutually exclusive.
 *
 * Best-effort: errors are logged but never thrown — labels must not block
 * ingestion / approval flows.
 */
export async function setFritzState(
  gmail: gmail_v1.Gmail,
  messageId: string,
  state: FritzState,
): Promise<void> {
  try {
    const labels = await ensureFritzLabels(gmail)
    const targetId = labels.get(state)
    if (!targetId) {
      logger.warn({ state }, 'fritz label id not found, skipping')
      return
    }
    const removeIds = [...labels.entries()]
      .filter(([s]) => s !== state)
      .map(([, id]) => id)

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: [targetId],
        removeLabelIds: removeIds,
      },
    })
    logger.debug({ messageId, state }, 'fritz label set')
  } catch (err) {
    logger.error({ err, messageId, state }, 'failed to set fritz label')
  }
}

export { stateByName }
