CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"kind" text NOT NULL,
	"source" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_kind_check" CHECK ("findings"."kind" in ('comparison', 'hotspot', 'leaderboard'))
);
--> statement-breakpoint
CREATE INDEX "findings_org_id_created_at_idx" ON "findings" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "findings" TO jams_web;
--> statement-breakpoint
ALTER TABLE "findings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "findings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS findings_org_isolation ON "findings";
--> statement-breakpoint
CREATE POLICY findings_org_isolation ON "findings"
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
