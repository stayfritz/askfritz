CREATE TYPE "public"."document_source" AS ENUM('gmail', 'dropbox', 'upload');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending_user', 'approved', 'executing', 'done', 'snoozed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."thread_status" AS ENUM('open', 'waiting_user', 'waiting_partner', 'closed');--> statement-breakpoint
CREATE TYPE "public"."topic_item_status" AS ENUM('missing', 'pending', 'blocked', 'registered', 'done');--> statement-breakpoint
CREATE TYPE "public"."topic_priority" AS ENUM('low', 'med', 'high');--> statement-breakpoint
CREATE TYPE "public"."topic_status" AS ENUM('in_progress', 'blocked', 'done', 'archived');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" text,
	"source" "document_source" NOT NULL,
	"source_id" text,
	"sender_person_id" text,
	"received_at" timestamp with time zone NOT NULL,
	"summary" text,
	"dropbox_path" text,
	"original_subject" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_language" varchar(8) DEFAULT 'de' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "persons" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"language" varchar(8),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" text,
	"description" text NOT NULL,
	"status" "task_status" DEFAULT 'pending_user' NOT NULL,
	"draft_content" text,
	"requires_decision" boolean DEFAULT true NOT NULL,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"domain_id" text,
	"topic_id" text,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "thread_status" DEFAULT 'open' NOT NULL,
	"last_message_at" timestamp with time zone,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topic_items" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "topic_item_status" DEFAULT 'missing' NOT NULL,
	"last_update_at" timestamp with time zone,
	"source_doc_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "topic_status" DEFAULT 'in_progress' NOT NULL,
	"priority" "topic_priority" DEFAULT 'med' NOT NULL,
	"due_date" timestamp with time zone,
	"owner_person_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_sender_person_id_persons_id_fk" FOREIGN KEY ("sender_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "persons" ADD CONSTRAINT "persons_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "threads" ADD CONSTRAINT "threads_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "threads" ADD CONSTRAINT "threads_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "topic_items" ADD CONSTRAINT "topic_items_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "topics" ADD CONSTRAINT "topics_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "topics" ADD CONSTRAINT "topics_owner_person_id_persons_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_topic_idx" ON "documents" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_source_idx" ON "documents" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_received_idx" ON "documents" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "persons_domain_idx" ON "persons" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_topic_idx" ON "tasks" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_external_idx" ON "threads" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_domain_idx" ON "threads" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_topic_idx" ON "threads" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_items_topic_idx" ON "topic_items" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_domain_idx" ON "topics" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_status_idx" ON "topics" USING btree ("status");