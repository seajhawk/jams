-- Close a tenant-isolation hole on share_links.
--
-- 0007 added share_links_token_select FOR SELECT TO jams_web USING (true) so the public
-- /share/[token] page could look a link up before it knew the org. Postgres ORs permissive
-- policies together, so that one policy made every share link, with its bearer token, readable
-- by the web role from any tenant context or none at all. App queries filtered by org, so this
-- was not reachable through the API, but it voided the RLS guarantee for the one table whose
-- rows are credentials.
--
-- The replacement only reveals the row whose token the caller has already presented. The share
-- page sets app.share_token for its own transaction before the lookup.
DROP POLICY IF EXISTS share_links_token_select ON share_links;
--> statement-breakpoint
CREATE POLICY share_links_token_select ON share_links
  FOR SELECT
  TO jams_web
  USING (
    current_setting('app.share_token', true) IS NOT NULL
    AND current_setting('app.share_token', true) <> ''
    AND token = current_setting('app.share_token', true)
  );
