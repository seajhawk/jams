CREATE TYPE "public"."dispatch_status" AS ENUM('pending', 'dispatched', 'failed');--> statement-breakpoint
CREATE TABLE "analysis_dispatch_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"status" "dispatch_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "analysis_dispatch_outbox" ADD CONSTRAINT "analysis_dispatch_outbox_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_dispatch_outbox_status_created_at_idx" ON "analysis_dispatch_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "analysis_dispatch_outbox_org_id_idx" ON "analysis_dispatch_outbox" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "analysis_dispatch_outbox_run_id_idx" ON "analysis_dispatch_outbox" USING btree ("run_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE analysis_dispatch_outbox TO jams_web, jams_worker;--> statement-breakpoint
ALTER TABLE analysis_dispatch_outbox ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE analysis_dispatch_outbox FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS analysis_dispatch_outbox_org_isolation ON analysis_dispatch_outbox;--> statement-breakpoint
CREATE POLICY analysis_dispatch_outbox_org_isolation ON analysis_dispatch_outbox
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));