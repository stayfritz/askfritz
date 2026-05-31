CREATE TYPE "public"."task_kind" AS ENUM('reply', 'forward');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" "task_kind" DEFAULT 'reply' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "forward_to" text;