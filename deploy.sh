#!/usr/bin/env bash
# One-command Azure deploy for the Cortex chat proxy.
#
# What it does: creates a resource group, a storage account, and a Flex
# Consumption Function App (the plan that supports HTTP streaming), sets the
# app settings the proxy reads, builds the TypeScript, and publishes it.
# Safe to rerun; the az commands are idempotent.
#
# Prereqs: az CLI (run `az login` first), Azure Functions Core Tools v4
# (`npm i -g azure-functions-core-tools@4`), Node 20+.
#
# See SETUP.md Part 2 for the walkthrough this script belongs to.
set -euo pipefail

# ── EDIT THESE ────────────────────────────────────────────────────────────────
RG="rg-pbi-cortex-chat"              # resource group (created if missing)
LOCATION="eastus2"
FUNC_APP="PBI_CORTEX_CHAT_PROXY"     # e.g. msu-cortex-chat-proxy
STORAGE="pbicortexproxystorage"      # lowercase letters+digits, 3-24 chars

# Where the agent lives. Pre-filled for the MSU spartan-trends agent.
# If msu-prod doesn't resolve from Azure, use the regional URL instead:
# https://msu.east-us-2.azure.snowflakecomputing.com
SNOWFLAKE_ACCOUNT_URL="https://msu-prod.snowflakecomputing.com"
AGENT_DATABASE="DBS_ANALYTICS_AI"
AGENT_SCHEMA="SPARTAN_TRENDS_AI"
AGENT_NAME="SPARTAN_TRENDS_CA"

# The service user's token from snowflake/grant-existing-agent.sql step 5.
SNOWFLAKE_PAT="<paste the PAT here>"

# The key report users will paste into the visual. Auto-generated; or set your own.
PROXY_API_KEY="$(openssl rand -hex 24)"
# ──────────────────────────────────────────────────────────────────────────────

echo "== Resource group + Flex Consumption app (HTTP streaming capable)"
az group create -n "$RG" -l "$LOCATION" -o none
az storage account create -n "$STORAGE" -g "$RG" -l "$LOCATION" --sku Standard_LRS -o none
az functionapp create -g "$RG" -n "$FUNC_APP" \
  --flexconsumption-location "$LOCATION" \
  --runtime node --runtime-version 20 \
  --storage-account "$STORAGE" -o none

echo "== App settings"
az functionapp config appsettings set -g "$RG" -n "$FUNC_APP" -o none --settings \
  SNOWFLAKE_ACCOUNT_URL="$SNOWFLAKE_ACCOUNT_URL" \
  SNOWFLAKE_PAT="$SNOWFLAKE_PAT" \
  AGENT_DATABASE="$AGENT_DATABASE" AGENT_SCHEMA="$AGENT_SCHEMA" AGENT_NAME="$AGENT_NAME" \
  PROXY_API_KEY="$PROXY_API_KEY" \
  ALLOWED_ORIGINS="https://app.powerbi.com"

echo "== Build + publish"
( cd "$(dirname "$0")/proxy" && npm install --no-audit --no-fund && npm run build \
  && func azure functionapp publish "$FUNC_APP" )

echo
echo "--------------------------------------------------------------"
echo "Proxy URL (paste into the visual's Format > Cortex Agent pane):"
echo "  https://${FUNC_APP}.azurewebsites.net/api/agent"
echo "Access key (give to report users; they paste it once in the visual):"
echo "  ${PROXY_API_KEY}"
echo "--------------------------------------------------------------"
echo "Post-deploy: tighten the Snowflake network policy to this app's"
echo "outbound IPs:  az functionapp show -g $RG -n $FUNC_APP --query outboundIpAddresses"
echo "Smoke test:"
echo "  curl -N -X POST https://${FUNC_APP}.azurewebsites.net/api/agent \\"
echo "    -H 'Content-Type: application/json' -H \"x-proxy-key: ${PROXY_API_KEY}\" \\"
echo "    -d '{\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}]}'"
