#!/usr/bin/env bash
# One-command Azure deploy for the Cortex chat proxy.
# Prereqs: az CLI (logged in), Azure Functions Core Tools v4, Node 20+.
set -euo pipefail

# ── EDIT THESE ────────────────────────────────────────────────────────────────
RG="rg-cortex-chat"
LOCATION="eastus2"
FUNC_APP="<globally-unique-func-name>"          # e.g. ryan-cortex-proxy
STORAGE="<globallyuniquestorage>"               # lowercase, 3-24 chars
SNOWFLAKE_ACCOUNT_URL="https://<org>-<account>.snowflakecomputing.com"
SNOWFLAKE_PAT="<paste PAT from setup.sql step 6>"
AGENT_DATABASE="AI_DB"; AGENT_SCHEMA="AGENTS"; AGENT_NAME="REPORT_CHAT_AGENT"
PROXY_API_KEY="$(openssl rand -hex 24)"         # or set your own
# ──────────────────────────────────────────────────────────────────────────────

echo "▸ Resource group + Flex Consumption app (HTTP streaming capable)"
az group create -n "$RG" -l "$LOCATION" -o none
az storage account create -n "$STORAGE" -g "$RG" -l "$LOCATION" --sku Standard_LRS -o none
az functionapp create -g "$RG" -n "$FUNC_APP" \
  --flexconsumption-location "$LOCATION" \
  --runtime node --runtime-version 20 \
  --storage-account "$STORAGE" -o none

echo "▸ App settings"
az functionapp config appsettings set -g "$RG" -n "$FUNC_APP" -o none --settings \
  SNOWFLAKE_ACCOUNT_URL="$SNOWFLAKE_ACCOUNT_URL" \
  SNOWFLAKE_PAT="$SNOWFLAKE_PAT" \
  AGENT_DATABASE="$AGENT_DATABASE" AGENT_SCHEMA="$AGENT_SCHEMA" AGENT_NAME="$AGENT_NAME" \
  PROXY_API_KEY="$PROXY_API_KEY" \
  ALLOWED_ORIGINS="https://app.powerbi.com"

echo "▸ Build + publish"
( cd "$(dirname "$0")/proxy" && npm install --no-audit --no-fund && npm run build \
  && func azure functionapp publish "$FUNC_APP" )

echo
echo "════════════════════════════════════════════════════════════"
echo "Proxy URL (paste into the visual's Format ▸ Cortex Agent):"
echo "  https://${FUNC_APP}.azurewebsites.net/api/agent"
echo "Access key (give to report users; they paste it once in the visual):"
echo "  ${PROXY_API_KEY}"
echo "════════════════════════════════════════════════════════════"
echo "Post-deploy: tighten snowflake/setup.sql network policy to this app's"
echo "outbound IPs:  az functionapp show -g $RG -n $FUNC_APP --query outboundIpAddresses"
echo "Smoke test:"
echo "  curl -N -X POST https://${FUNC_APP}.azurewebsites.net/api/agent \\"
echo "    -H 'Content-Type: application/json' -H \"x-proxy-key: ${PROXY_API_KEY}\" \\"
echo "    -d '{\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}]}'"
