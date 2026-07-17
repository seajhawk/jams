CREATE TYPE "public"."analysis_error_code" AS ENUM('no_audio', 'too_long', 'corrupt_file', 'transient', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."analysis_status" AS ENUM('queued', 'running', 'succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."measure_category" AS ENUM('physical', 'cognitive', 'time', 'sentiment');--> statement-breakpoint
CREATE TYPE "public"."measure_source" AS ENUM('video_analysis', 'telemetry', 'manual');--> statement-breakpoint
CREATE TABLE "analysis_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"blob_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"video_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pipeline_version" text NOT NULL,
	"provider_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "analysis_status" DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"progress_pct" integer DEFAULT 0 NOT NULL,
	"stage_detail" text,
	"error_code" "analysis_error_code",
	"attempt" integer DEFAULT 0 NOT NULL,
	"superseded_by" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "analysis_runs_progress_pct_check" CHECK ("analysis_runs"."progress_pct" >= 0 and "analysis_runs"."progress_pct" <= 100)
);
--> statement-breakpoint
CREATE TABLE "measures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"category" "measure_category" NOT NULL,
	"t_start_ms" integer NOT NULL,
	"t_end_ms" integer,
	"value_num" real,
	"value_text" text,
	"unit" text,
	"confidence" real,
	"source" "measure_source" NOT NULL,
	"provider_id" text NOT NULL,
	"provider_version" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "measures_t_start_ms_check" CHECK ("measures"."t_start_ms" >= 0),
	CONSTRAINT "measures_t_end_ms_check" CHECK ("measures"."t_end_ms" is null or "measures"."t_end_ms" >= "measures"."t_start_ms")
);
--> statement-breakpoint
ALTER TABLE "analysis_artifacts" ADD CONSTRAINT "analysis_artifacts_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_superseded_by_analysis_runs_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."analysis_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measures" ADD CONSTRAINT "measures_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_artifacts_org_id_run_id_idx" ON "analysis_artifacts" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "analysis_artifacts_run_id_kind_idx" ON "analysis_artifacts" USING btree ("run_id","kind");--> statement-breakpoint
CREATE INDEX "analysis_runs_org_id_video_id_idx" ON "analysis_runs" USING btree ("org_id","video_id");--> statement-breakpoint
CREATE INDEX "analysis_runs_org_id_status_idx" ON "analysis_runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "analysis_runs_superseded_by_idx" ON "analysis_runs" USING btree ("superseded_by");--> statement-breakpoint
CREATE INDEX "measures_run_id_kind_t_start_ms_idx" ON "measures" USING btree ("run_id","kind","t_start_ms");--> statement-breakpoint
CREATE INDEX "measures_org_id_kind_idx" ON "measures" USING btree ("org_id","kind");