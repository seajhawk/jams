#!/usr/bin/env bash
# Summarize worker pipeline throughput per run from Log Analytics.
# Usage: scripts/ops/pipeline-perf.sh [days=7] [resource-group=rg-jams-staging]
set -euo pipefail
DAYS="${1:-7}"
RG="${2:-rg-jams-staging}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WS=$(az monitor log-analytics workspace list -g "$RG" --query "[0].customerId" -o tsv)
[ -n "$WS" ] || { echo "no Log Analytics workspace in $RG" >&2; exit 1; }

QUERY=$(sed "s/__DAYS__/${DAYS}/" "$HERE/pipeline-perf.kql")
az monitor log-analytics query -w "$WS" --analytics-query "$QUERY" -o json |
  python3 -c '
import json, sys
rows = json.load(sys.stdin)
if not rows:
    print("no completed runs in the window"); raise SystemExit
def cell(v, w):
    return ("" if v is None else str(v)).ljust(w)
head = ["run", "status", "media_s", "res", "total_s", "x_realtime", "download_s", "normalize_s", "upload_s"]
print(" ".join(cell(h, 12) for h in head))
for r in rows:
    print(" ".join(cell(r.get(h), 12) for h in head))
    if r.get("provider_s"):
        print("    providers(s):", r["provider_s"])
'
