CREATE TYPE "public"."webhook_event_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "status" "webhook_event_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status");--> statement-breakpoint
UPDATE "webhook_events" SET "status" = 'completed', "attempt_count" = 1, "last_attempt_at" = "processed_at" WHERE "processed_at" IS NOT NULL;