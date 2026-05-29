import { config } from '../lib/config.js'
import { db } from '../integrations/postgres/db.js'
import { domains, persons } from '../integrations/postgres/schema.js'
import { logger } from '../lib/logger.js'

/**
 * Idempotently sync declarative entities from config (YAML) to DB.
 * Domains and persons are the "identity layer" — config is source of truth.
 * Topics, documents, tasks, threads are dynamic and only live in DB.
 *
 * This is upsert-only: never deletes DB rows that have no config counterpart,
 * to avoid losing data when a config entry is temporarily removed.
 */
export async function syncConfigToDb(): Promise<void> {
  await syncDomains()
  await syncPersons()
}

async function syncDomains(): Promise<void> {
  const now = new Date()
  for (const d of config.domains.domains) {
    await db
      .insert(domains)
      .values({
        id: d.id,
        name: d.name,
        description: d.description ?? null,
        defaultLanguage: d.default_language,
      })
      .onConflictDoUpdate({
        target: domains.id,
        set: {
          name: d.name,
          description: d.description ?? null,
          defaultLanguage: d.default_language,
          updatedAt: now,
        },
      })
  }
  logger.info({ count: config.domains.domains.length }, 'domains synced')
}

async function syncPersons(): Promise<void> {
  const now = new Date()
  for (const p of config.persons.persons) {
    await db
      .insert(persons)
      .values({
        id: p.id,
        domainId: p.domain_id,
        name: p.name,
        role: p.role ?? null,
        emails: p.emails,
        phones: p.phones,
        language: p.language ?? null,
        notes: p.notes ?? null,
      })
      .onConflictDoUpdate({
        target: persons.id,
        set: {
          domainId: p.domain_id,
          name: p.name,
          role: p.role ?? null,
          emails: p.emails,
          phones: p.phones,
          language: p.language ?? null,
          notes: p.notes ?? null,
          updatedAt: now,
        },
      })
  }
  logger.info({ count: config.persons.persons.length }, 'persons synced')
}
