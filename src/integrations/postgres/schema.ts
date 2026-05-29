import {
  pgTable,
  text,
  varchar,
  timestamp,
  jsonb,
  boolean,
  pgEnum,
  uuid,
  index,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

export const topicStatus = pgEnum('topic_status', [
  'in_progress',
  'blocked',
  'done',
  'archived',
])

export const topicPriority = pgEnum('topic_priority', ['low', 'med', 'high'])

export const topicItemStatus = pgEnum('topic_item_status', [
  'missing',
  'pending',
  'blocked',
  'registered',
  'done',
])

export const documentSource = pgEnum('document_source', [
  'gmail',
  'dropbox',
  'upload',
])

export const taskStatus = pgEnum('task_status', [
  'pending_user',
  'approved',
  'executing',
  'done',
  'snoozed',
  'cancelled',
])

export const threadStatus = pgEnum('thread_status', [
  'open',
  'waiting_user',
  'waiting_partner',
  'closed',
])

export const domains = pgTable('domains', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  defaultLanguage: varchar('default_language', { length: 8 })
    .notNull()
    .default('de'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const persons = pgTable(
  'persons',
  {
    id: text('id').primaryKey(),
    domainId: text('domain_id')
      .notNull()
      .references(() => domains.id),
    name: text('name').notNull(),
    role: text('role'),
    emails: jsonb('emails').$type<string[]>().notNull().default([]),
    phones: jsonb('phones').$type<string[]>().notNull().default([]),
    language: varchar('language', { length: 8 }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    domainIdx: index('persons_domain_idx').on(table.domainId),
  }),
)

export const topics = pgTable(
  'topics',
  {
    id: text('id').primaryKey(),
    domainId: text('domain_id')
      .notNull()
      .references(() => domains.id),
    name: text('name').notNull(),
    status: topicStatus('status').notNull().default('in_progress'),
    priority: topicPriority('priority').notNull().default('med'),
    dueDate: timestamp('due_date', { withTimezone: true }),
    ownerPersonId: text('owner_person_id').references(() => persons.id),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    domainIdx: index('topics_domain_idx').on(table.domainId),
    statusIdx: index('topics_status_idx').on(table.status),
  }),
)

export const topicItems = pgTable(
  'topic_items',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: topicItemStatus('status').notNull().default('missing'),
    lastUpdateAt: timestamp('last_update_at', { withTimezone: true }),
    sourceDocId: uuid('source_doc_id'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    topicIdx: index('topic_items_topic_idx').on(table.topicId),
  }),
)

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topicId: text('topic_id').references(() => topics.id, {
      onDelete: 'set null',
    }),
    source: documentSource('source').notNull(),
    sourceId: text('source_id'),
    senderPersonId: text('sender_person_id').references(() => persons.id),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    summary: text('summary'),
    dropboxPath: text('dropbox_path'),
    originalSubject: text('original_subject'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    topicIdx: index('documents_topic_idx').on(table.topicId),
    sourceIdx: index('documents_source_idx').on(table.source, table.sourceId),
    receivedIdx: index('documents_received_idx').on(table.receivedAt),
  }),
)

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topicId: text('topic_id').references(() => topics.id, {
      onDelete: 'set null',
    }),
    description: text('description').notNull(),
    status: taskStatus('status').notNull().default('pending_user'),
    draftContent: text('draft_content'),
    requiresDecision: boolean('requires_decision').notNull().default(true),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusIdx: index('tasks_status_idx').on(table.status),
    topicIdx: index('tasks_topic_idx').on(table.topicId),
  }),
)

export const threads = pgTable(
  'threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id'),
    domainId: text('domain_id').references(() => domains.id),
    topicId: text('topic_id').references(() => topics.id, {
      onDelete: 'set null',
    }),
    participants: jsonb('participants')
      .$type<string[]>()
      .notNull()
      .default([]),
    status: threadStatus('status').notNull().default('open'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    summary: text('summary'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    externalIdx: index('threads_external_idx').on(table.externalId),
    domainIdx: index('threads_domain_idx').on(table.domainId),
    topicIdx: index('threads_topic_idx').on(table.topicId),
  }),
)

export const domainsRelations = relations(domains, ({ many }) => ({
  persons: many(persons),
  topics: many(topics),
  threads: many(threads),
}))

export const personsRelations = relations(persons, ({ one, many }) => ({
  domain: one(domains, {
    fields: [persons.domainId],
    references: [domains.id],
  }),
  ownedTopics: many(topics),
  documents: many(documents),
}))

export const topicsRelations = relations(topics, ({ one, many }) => ({
  domain: one(domains, {
    fields: [topics.domainId],
    references: [domains.id],
  }),
  owner: one(persons, {
    fields: [topics.ownerPersonId],
    references: [persons.id],
  }),
  items: many(topicItems),
  documents: many(documents),
  tasks: many(tasks),
  threads: many(threads),
}))

export const topicItemsRelations = relations(topicItems, ({ one }) => ({
  topic: one(topics, {
    fields: [topicItems.topicId],
    references: [topics.id],
  }),
}))

export const documentsRelations = relations(documents, ({ one }) => ({
  topic: one(topics, {
    fields: [documents.topicId],
    references: [topics.id],
  }),
  sender: one(persons, {
    fields: [documents.senderPersonId],
    references: [persons.id],
  }),
}))

export const tasksRelations = relations(tasks, ({ one }) => ({
  topic: one(topics, {
    fields: [tasks.topicId],
    references: [topics.id],
  }),
}))

export const threadsRelations = relations(threads, ({ one }) => ({
  domain: one(domains, {
    fields: [threads.domainId],
    references: [domains.id],
  }),
  topic: one(topics, {
    fields: [threads.topicId],
    references: [topics.id],
  }),
}))
