ALTER TYPE "public"."analysis_error_code" ADD VALUE 'too_large';--> statement-breakpoint
ALTER TYPE "public"."analysis_error_code" ADD VALUE 'unsupported_media';--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_counters_bucket_window_start_pk" PRIMARY KEY("bucket","window_start")
);
--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "upload_sources_cleaned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "rate_limit_counters_expires_at_idx" ON "rate_limit_counters" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "analysis_runs_org_id_created_at_idx" ON "analysis_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "analysis_runs_active_idx" ON "analysis_runs" USING btree ("status") WHERE "analysis_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "videos_created_at_idx" ON "videos" USING btree ("created_at");
--> statement-breakpoint
-- Rate-limit counters are not tenant data (buckets are SHA-256 hashes), so no RLS; the web role
-- upserts and purges them.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rate_limit_counters TO jams_web;
--> statement-breakpoint
-- Global circuit breakers. The web role runs under tenant RLS and cannot see other organizations'
-- rows, so these security-definer functions return only an aggregate across all of them. They run
-- as the migration role, which owns the tables; FORCE ROW LEVEL SECURITY applies to owners too
-- unless the role has BYPASSRLS, so give that role (and only it) an explicit read policy. This is a
-- no-op for a superuser such as the local and CI "jams" role, and changes nothing for jams_web.
CREATE POLICY analysis_runs_admission_count ON analysis_runs FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
CREATE POLICY videos_admission_count ON videos FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
CREATE FUNCTION jams_global_active_analysis_count() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ select count(*) from analysis_runs where status in ('queued', 'running') $$;
--> statement-breakpoint
CREATE FUNCTION jams_global_upload_bytes_since(since timestamptz) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ select coalesce(sum(coalesce(size_bytes, 0)), 0)::bigint from videos where created_at >= since $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jams_global_active_analysis_count() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jams_global_upload_bytes_since(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION jams_global_active_analysis_count() TO jams_web;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION jams_global_upload_bytes_since(timestamptz) TO jams_web;