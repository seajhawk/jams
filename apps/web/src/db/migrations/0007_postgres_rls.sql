DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jams_web') THEN
    CREATE ROLE jams_web LOGIN PASSWORD 'jams_web' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  ALTER ROLE jams_web NOBYPASSRLS;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jams_worker') THEN
    CREATE ROLE jams_worker LOGIN PASSWORD 'jams_worker' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
  ALTER ROLE jams_worker BYPASSRLS;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO jams_web, jams_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  orgs,
  tasks,
  videos,
  analysis_runs,
  analysis_artifacts,
  measures,
  segments,
  weight_profiles,
  effort_scores,
  share_links
TO jams_web;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jams_worker;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jams_web, jams_worker;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jams_worker;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO jams_web, jams_worker;
--> statement-breakpoint
REVOKE ALL ON TABLE users, webhook_events FROM jams_web;
--> statement-breakpoint
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS orgs_org_isolation ON orgs;
--> statement-breakpoint
CREATE POLICY orgs_org_isolation ON orgs
  TO jams_web
  USING (id = current_setting('app.org_id', true))
  WITH CHECK (id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tasks_org_isolation ON tasks;
--> statement-breakpoint
CREATE POLICY tasks_org_isolation ON tasks
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE videos FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS videos_org_isolation ON videos;
--> statement-breakpoint
CREATE POLICY videos_org_isolation ON videos
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE analysis_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE analysis_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS analysis_runs_org_isolation ON analysis_runs;
--> statement-breakpoint
CREATE POLICY analysis_runs_org_isolation ON analysis_runs
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE analysis_artifacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE analysis_artifacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS analysis_artifacts_org_isolation ON analysis_artifacts;
--> statement-breakpoint
CREATE POLICY analysis_artifacts_org_isolation ON analysis_artifacts
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE measures ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE measures FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS measures_org_isolation ON measures;
--> statement-breakpoint
CREATE POLICY measures_org_isolation ON measures
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE segments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS segments_org_isolation ON segments;
--> statement-breakpoint
CREATE POLICY segments_org_isolation ON segments
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE weight_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE weight_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS weight_profiles_org_isolation ON weight_profiles;
--> statement-breakpoint
CREATE POLICY weight_profiles_org_isolation ON weight_profiles
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE effort_scores ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE effort_scores FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS effort_scores_org_isolation ON effort_scores;
--> statement-breakpoint
CREATE POLICY effort_scores_org_isolation ON effort_scores
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
ALTER TABLE share_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE share_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS share_links_org_isolation ON share_links;
--> statement-breakpoint
CREATE POLICY share_links_org_isolation ON share_links
  TO jams_web
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS share_links_token_select ON share_links;
--> statement-breakpoint
CREATE POLICY share_links_token_select ON share_links
  FOR SELECT
  TO jams_web
  USING (true);
