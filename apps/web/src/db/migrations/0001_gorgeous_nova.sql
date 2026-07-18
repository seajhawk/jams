CREATE TYPE "public"."video_status" AS ENUM('uploading', 'uploaded', 'failed');--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"task_id" uuid,
	"title" text NOT NULL,
	"blob_path" text NOT NULL,
	"poster_blob_path" text,
	"size_bytes" bigint,
	"content_type" text,
	"duration_ms" integer,
	"width" integer,
	"height" integer,
	"fps" real,
	"has_audio" boolean,
	"subject_label" text,
	"variant_label" text,
	"status" "video_status" DEFAULT 'uploading' NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "videos_status_check" CHECK ("videos"."status" in ('uploading', 'uploaded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_org_id_name_idx" ON "tasks" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "tasks_org_id_idx" ON "tasks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "videos_org_id_created_at_idx" ON "videos" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "videos_org_id_task_id_idx" ON "videos" USING btree ("org_id","task_id");