#!/usr/bin/env bash
# Apply Drizzle migrations to an Azure Postgres Flexible Server, then re-assert the application
# role passwords. Used by the deploy pipeline (between provision and deploy) and by hand.
#
# The server only admits known IPs, so this opens a rule for the caller's public IP and removes it
# on exit, success or failure. Secrets come from the environment and are never printed.
#
# Required env:
#   AZURE_RESOURCE_GROUP, AZURE_POSTGRES_SERVER_FQDN
#   POSTGRES_ADMIN_PASSWORD, JAMS_WEB_DB_PASSWORD, JAMS_WORKER_DB_PASSWORD
# Optional: POSTGRES_ADMIN_USER (default jamsadmin), FIREWALL_RULE_NAME
#
# Local use (after `az login`), with values from the azd environment:
#   eval "$(azd env get-values -e jams-staging | grep -E '^(AZURE_RESOURCE_GROUP|AZURE_POSTGRES_SERVER_FQDN|POSTGRES_ADMIN_PASSWORD|JAMS_WEB_DB_PASSWORD|JAMS_WORKER_DB_PASSWORD)=' | sed 's/^/export /')"
#   scripts/ops/migrate-azure-db.sh
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?}" "${AZURE_POSTGRES_SERVER_FQDN:?}" "${POSTGRES_ADMIN_PASSWORD:?}"
: "${JAMS_WEB_DB_PASSWORD:?}" "${JAMS_WORKER_DB_PASSWORD:?}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER="${AZURE_POSTGRES_SERVER_FQDN%%.*}"
ADMIN_USER="${POSTGRES_ADMIN_USER:-jamsadmin}"
RULE="${FIREWALL_RULE_NAME:-migrate-$(date -u +%Y%m%d%H%M%S)}"

IP="$(curl -fsS --retry 3 https://api.ipify.org)"
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "could not determine public IP" >&2; exit 1; }

cleanup() {
  az postgres flexible-server firewall-rule delete -g "$AZURE_RESOURCE_GROUP" -s "$SERVER" -n "$RULE" --yes -o none \
    && echo "firewall rule $RULE removed" \
    || echo "::warning::could not remove firewall rule $RULE on $SERVER; delete it by hand" >&2
}
trap cleanup EXIT

echo "opening $SERVER to $IP as $RULE"
az postgres flexible-server firewall-rule create -g "$AZURE_RESOURCE_GROUP" -s "$SERVER" -n "$RULE" \
  --start-ip-address "$IP" --end-ip-address "$IP" -o none

# Percent-encode the password so any character is safe inside the URL.
ENCODED="$(node -e 'process.stdout.write(encodeURIComponent(process.env.POSTGRES_ADMIN_PASSWORD))')"
export DATABASE_URL="postgresql://${ADMIN_USER}:${ENCODED}@${AZURE_POSTGRES_SERVER_FQDN}:5432/jams?sslmode=require"

# A new rule can take a few seconds to apply; retry the connection rather than fail the deploy.
cd "$REPO/apps/web"
for attempt in 1 2 3 4 5 6; do
  if node -e 'const s=require("postgres")(process.env.DATABASE_URL,{max:1,connect_timeout:10});s`select 1`.then(()=>s.end()).catch(e=>{console.error(e.message);process.exit(1)})'; then
    break
  fi
  [[ $attempt -eq 6 ]] && { echo "database unreachable after firewall rule" >&2; exit 1; }
  sleep 5
done

pnpm exec drizzle-kit migrate
node scripts/sync-db-roles.mjs
