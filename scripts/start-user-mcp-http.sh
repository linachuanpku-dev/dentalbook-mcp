#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")

if [ -z "${DENTALBOOK_USER_CONFIG:-}" ]; then
  DENTALBOOK_USER_CONFIG="$PROJECT_DIR/.dentalbook-local/user.json"
  export DENTALBOOK_USER_CONFIG
fi

LOCAL_CA="$PROJECT_DIR/.dentalbook-local/center-ca.pem"
if [ -f "$LOCAL_CA" ] && [ -z "${NODE_EXTRA_CA_CERTS:-}" ]; then
  NODE_EXTRA_CA_CERTS="$LOCAL_CA"
  export NODE_EXTRA_CA_CERTS
fi

if [ ! -f "$PROJECT_DIR/packages/mcp-user/dist/index.js" ]; then
  echo "Dentalbook user MCP is not built. Run npm install && npm run build." >&2
  exit 1
fi

export DENTALBOOK_USER_MCP_TRANSPORT=http
exec node "$PROJECT_DIR/packages/mcp-user/dist/index.js"
