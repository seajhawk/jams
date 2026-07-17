CREATE TYPE "public"."segment_source" AS ENUM('audio_cue', 'scene_boundary', 'llm', 'manual');--> statement-breakpoint
CREATE TABLE "effort_scores" (
	"run_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"physical" integer NOT NULL,
	"cognitive" integer NOT NULL,
	"time" integer NOT NULL,
	"sentiment" integer NOT NULL,
	"speech" integer NOT NULL,
	"total" integer NOT NULL,
	"breakdown" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "effort_scores_run_id_profile_id_pk" PRIMARY KEY("run_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"parent_segment_id" uuid,
	"name" text NOT NULL,
	"t_start_ms" integer NOT NULL,
	"t_end_ms" integer NOT NULL,
	"source" "segment_source" NOT NULL,
	"thumbnail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_t_start_ms_check" CHECK ("segments"."t_start_ms" >= 0),
	CONSTRAINT "segments_t_end_ms_check" CHECK ("segments"."t_end_ms" > "segments"."t_start_ms")
);
--> statement-breakpoint
CREATE TABLE "weight_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"weights" jsonb NOT NULL,
	"normalization" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
INSERT INTO "weight_profiles" ("org_id", "name", "weights", "normalization", "is_default")
SELECT
	"id",
	'Default',
	'{"context_switch":3,"sentiment":4,"spoken_word":1,"time_segment":2}'::jsonb,
	'{"context_switch":"per_minute","sentiment":"neg_density","spoken_word":"per_minute","time_segment":"raw_minutes"}'::jsonb,
	true
FROM "orgs"
WHERE "deleted_at" IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "effort_scores" ADD CONSTRAINT "effort_scores_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effort_scores" ADD CONSTRAINT "effort_scores_profile_id_weight_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."weight_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_parent_segment_id_segments_id_fk" FOREIGN KEY ("parent_segment_id") REFERENCES "public"."segments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "effort_scores_org_id_run_id_idx" ON "effort_scores" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "segments_org_id_run_id_idx" ON "segments" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "segments_run_id_t_start_ms_idx" ON "segments" USING btree ("run_id","t_start_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "weight_profiles_org_id_name_idx" ON "weight_profiles" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "weight_profiles_org_id_default_idx" ON "weight_profiles" USING btree ("org_id") WHERE "weight_profiles"."is_default" = true;--> statement-breakpoint
CREATE INDEX "weight_profiles_org_id_idx" ON "weight_profiles" USING btree ("org_id");
