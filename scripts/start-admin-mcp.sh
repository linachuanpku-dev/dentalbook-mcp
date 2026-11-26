#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
ENV_FILE="$PROJECT_DIR/.dentalbook-local/admin.env"

if [ -z "${DENTALBOOK_ADMIN_CENTER_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

LOCAL_CA="$PROJECT_DIR/.dentalbook-local/center-ca.pem"
if [ -f "$LOCAL_CA" ] && [ -z "${NODE_EXTRA_CA_CERTS:-}" ]; then
  NODE_EXTRA_CA_CERTS="$LOCAL_CA"
  export NODE_EXTRA_CA_CERTS
fi

if [ ! -f "$PROJECT_DIR/packages/mcp-admin/dist/index.js" ]; then
  echo "Dentalbook admin MCP is not built. Run npm install && npm run build." >&2
  exit 1
fi

exec node "$PROJECT_DIR/packages/mcp-admin/dist/index.js"
