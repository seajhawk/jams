CREATE TABLE "recording_deletions" (
	"video_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_ids" jsonb NOT NULL,
	"analysis_count" integer NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_sweep_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "recording_deletions_usage_check" CHECK ("recording_deletions"."analysis_count" >= 0 and "recording_deletions"."reserved_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX "recording_deletions_org_idx" ON "recording_deletions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "recording_deletions_sweep_idx" ON "recording_deletions" USING btree ("next_sweep_at");
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE recording_deletions TO jams_web;
--> statement-breakpoint
ALTER TABLE recording_deletions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recording_deletions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recording_deletions_org_isolation ON recording_deletions
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
