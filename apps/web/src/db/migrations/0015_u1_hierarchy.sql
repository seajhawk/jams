CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"success_criterion" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"label" text NOT NULL,
	"cohorts" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"name" text NOT NULL,
	"build" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "tasks_org_id_name_idx";--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "fingerprint" jsonb;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "fingerprint_hash" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "participant_id" uuid;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "variant_id" uuid;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goals_project_id_name_idx" ON "goals" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "goals_org_id_idx" ON "goals" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_org_id_label_idx" ON "participants" USING btree ("org_id",lower("label"));--> statement-breakpoint
CREATE INDEX "participants_org_id_idx" ON "participants" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_id_name_idx" ON "projects" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "projects_org_id_idx" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_task_id_name_idx" ON "variants" USING btree ("task_id","name");--> statement-breakpoint
CREATE INDEX "variants_org_id_idx" ON "variants" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_goal_id_name_idx" ON "tasks" USING btree ("goal_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_org_id_name_ungrouped_idx" ON "tasks" USING btree ("org_id","name") WHERE "tasks"."goal_id" is null;--> statement-breakpoint
CREATE INDEX "tasks_goal_id_idx" ON "tasks" USING btree ("goal_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" in ('active', 'retired'));--> statement-breakpoint
-- Backfill (U1). Runs before RLS is enabled on the new tables: FORCE ROW LEVEL SECURITY applies to
-- the owner too and the policies below only name jams_web. Idempotent.
INSERT INTO "projects" ("org_id", "name")
SELECT DISTINCT "org_id", 'My product' FROM "tasks"
ON CONFLICT ("org_id", "name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "goals" ("org_id", "project_id", "name", "description")
SELECT t."org_id", p."id", t."name", t."description"
FROM "tasks" t
JOIN "projects" p ON p."org_id" = t."org_id" AND p."name" = 'My product'
WHERE t."goal_id" IS NULL
ON CONFLICT ("project_id", "name") DO NOTHING;
--> statement-breakpoint
UPDATE "tasks" t
SET "goal_id" = g."id"
FROM "goals" g
JOIN "projects" p ON p."id" = g."project_id"
WHERE t."goal_id" IS NULL
  AND p."org_id" = t."org_id"
  AND p."name" = 'My product'
  AND g."name" = t."name";
--> statement-breakpoint
INSERT INTO "participants" ("org_id", "label")
SELECT DISTINCT ON ("org_id", lower(btrim("subject_label"))) "org_id", btrim("subject_label")
FROM "videos"
WHERE "subject_label" IS NOT NULL AND btrim("subject_label") <> ''
ORDER BY "org_id", lower(btrim("subject_label")), "created_at"
ON CONFLICT ("org_id", lower("label")) DO NOTHING;
--> statement-breakpoint
UPDATE "videos" v
SET "participant_id" = p."id"
FROM "participants" p
WHERE v."participant_id" IS NULL
  AND p."org_id" = v."org_id"
  AND lower(p."label") = lower(btrim(v."subject_label"));
--> statement-breakpoint
INSERT INTO "variants" ("org_id", "task_id", "name")
SELECT DISTINCT "org_id", "task_id", btrim("variant_label")
FROM "videos"
WHERE "task_id" IS NOT NULL AND "variant_label" IS NOT NULL AND btrim("variant_label") <> ''
ON CONFLICT ("task_id", "name") DO NOTHING;
--> statement-breakpoint
UPDATE "videos" v
SET "variant_id" = va."id"
FROM "variants" va
WHERE v."variant_id" IS NULL
  AND va."task_id" = v."task_id"
  AND va."name" = btrim(v."variant_label");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "projects", "goals", "participants", "variants" TO jams_web;
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS projects_org_isolation ON "projects";
--> statement-breakpoint
CREATE POLICY projects_org_isolation ON "projects"
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "goals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS goals_org_isolation ON "goals";
--> statement-breakpoint
CREATE POLICY goals_org_isolation ON "goals"
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE "participants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "participants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS participants_org_isolation ON "participants";
--> statement-breakpoint
CREATE POLICY participants_org_isolation ON "participants"
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE "variants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "variants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS variants_org_isolation ON "variants";
--> statement-breakpoint
CREATE POLICY variants_org_isolation ON "variants"
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
