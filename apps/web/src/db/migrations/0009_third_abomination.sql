ALTER TABLE "analysis_artifacts" ADD COLUMN "attempt" integer;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "analysis_runs_lease_expires_at_idx" ON "analysis_runs" USING btree ("lease_expires_at");