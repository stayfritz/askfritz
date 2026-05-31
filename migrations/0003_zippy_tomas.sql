ALTER TYPE "public"."task_kind" ADD VALUE 'calendar_event';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "calendar_payload" jsonb;