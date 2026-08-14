#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/com.vercel.cli/auth.json')))['token'])")
ORG=team_nfjLuZWz0IpR3KggqmW3sLIT
PID=prj_nrYrxo1wgmJKzUgxvhYoUcbhcqoG
SECRET=$(python3 -c "import secrets; print(secrets.token_hex(24))")

for target in production preview; do
  echo "setting CRON_SECRET ($target)..."
  PAYLOAD_FILE=$(mktemp)
  cat > "$PAYLOAD_FILE" <<EOF
{"key":"CRON_SECRET","value":"$SECRET","type":"sensitive","target":["$target"]}
EOF
  status=$(curl -s -o /tmp/cron_env_resp.json -w "%{http_code}" -X POST \
    "https://api.vercel.com/v10/projects/$PID/env?teamId=$ORG&upsert=true" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data-binary "@$PAYLOAD_FILE")
  rm -f "$PAYLOAD_FILE"
  echo "  status: $status"
  if [ "$status" -ge 300 ]; then cat /tmp/cron_env_resp.json; exit 1; fi
done

echo "$SECRET" > /tmp/cron_secret_prod.txt
echo "done. secret written to /tmp/cron_secret_prod.txt for Claude's verification step."
