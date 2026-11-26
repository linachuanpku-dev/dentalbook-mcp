#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${DENTALBOOK_INSTALL_BASE_URL:-https://dentalbook.example.com}"
INSTALL_ROOT="${DENTALBOOK_INSTALL_ROOT:-$HOME/.dentalbook}"
MCP_ROOT="$INSTALL_ROOT/mcp-user"
USER_JSON="$INSTALL_ROOT/user.json"
WRITE_AUTO=0
SKIP_NODE=0
UPGRADE=0
TOKEN=""
LOCAL_DATA_DIR=""
IMPORT_ROOT=""
IDE_OVERRIDE=""

usage() {
  cat <<'EOF'
Usage: install-mcp-user.sh [options]

  --write-auto              Detect IDE and merge MCP config (exits if unknown)
  --skip-node               Skip Node.js version check
  --upgrade                 Upgrade from manifest when a newer version exists
  --token TOKEN             Bearer token for dentalbook.example.com
  --local-data-dir PATH     Local SQLite directory (absolute path)
  --import-root PATH        Allowed PDF import directory (repeatable)
  --ide workbuddy|trae|claude|cursor|codex|qoder
  --user-json PATH          Override ~/.dentalbook/user.json path
  -h, --help                Show this help
EOF
}

log() { printf 'dentalbook-install: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --write-auto) WRITE_AUTO=1 ;;
    --skip-node) SKIP_NODE=1 ;;
    --upgrade) UPGRADE=1 ;;
    --token) shift; TOKEN="${1:-}"; [ -n "$TOKEN" ] || die "--token requires a value" ;;
    --local-data-dir) shift; LOCAL_DATA_DIR="${1:-}"; [ -n "$LOCAL_DATA_DIR" ] || die "--local-data-dir requires a value" ;;
    --import-root) shift; IMPORT_ROOT="${1:-}"; [ -n "$IMPORT_ROOT" ] || die "--import-root requires a value" ;;
    --ide) shift; IDE_OVERRIDE="${1:-}"; [ -n "$IDE_OVERRIDE" ] || die "--ide requires a value" ;;
    --user-json) shift; USER_JSON="${1:-}"; [ -n "$USER_JSON" ] || die "--user-json requires a value" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

if [ "$SKIP_NODE" -eq 0 ]; then
  need_cmd node
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22+ is required (found $(node -v)). Use npmmirror or omit --skip-node only after installing Node."
fi

need_cmd curl
need_cmd tar
need_cmd shasum

mkdir -p "$INSTALL_ROOT" "$MCP_ROOT"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dentalbook-mcp.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

MANIFEST_JSON="$TMP_DIR/manifest.json"
curl -fsSL "$BASE_URL/releases/mcp-user/manifest.json" -o "$MANIFEST_JSON"
TARGET_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$MANIFEST_JSON")"
TARGET_SHA256="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$MANIFEST_JSON")"

CURRENT_LINK="$MCP_ROOT/current"
CURRENT_VERSION=""
if [ -L "$CURRENT_LINK" ] || [ -d "$CURRENT_LINK" ]; then
  CURRENT_VERSION="$(basename "$(readlink "$CURRENT_LINK" 2>/dev/null || echo "")")"
fi

SHOULD_INSTALL=0
if [ -z "$CURRENT_VERSION" ]; then
  SHOULD_INSTALL=1
elif [ "$CURRENT_VERSION" = "$TARGET_VERSION" ]; then
  log "already on version $TARGET_VERSION"
elif [ "$UPGRADE" -eq 1 ]; then
  SHOULD_INSTALL=1
else
  log "installed version is $CURRENT_VERSION; manifest is $TARGET_VERSION (pass --upgrade to install)"
fi

if [ "$SHOULD_INSTALL" -eq 1 ] && [ ! -d "$MCP_ROOT/$TARGET_VERSION" ]; then
  ARCHIVE="$TMP_DIR/release.tar.gz"
  curl -fsSL "$BASE_URL/releases/mcp-user/latest.tar.gz" -o "$ARCHIVE"
  ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  [ "$ACTUAL_SHA256" = "$TARGET_SHA256" ] || die "tarball sha256 mismatch (expected $TARGET_SHA256, got $ACTUAL_SHA256)"
  mkdir -p "$MCP_ROOT/$TARGET_VERSION"
  tar -xzf "$ARCHIVE" -C "$MCP_ROOT/$TARGET_VERSION"
  log "installed MCP release $TARGET_VERSION"
fi

if [ -d "$MCP_ROOT/$TARGET_VERSION" ]; then
  ln -sfn "$MCP_ROOT/$TARGET_VERSION" "$CURRENT_LINK"
fi

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node not found in PATH"
ENTRY_JS="$MCP_ROOT/current/dist/index.js"
[ -f "$ENTRY_JS" ] || die "release entry missing at $ENTRY_JS"

if [ ! -f "$USER_JSON" ]; then
  [ -n "$TOKEN" ] || die "first install requires --token"
  [ -n "$LOCAL_DATA_DIR" ] || die "first install requires --local-data-dir"
  mkdir -p "$LOCAL_DATA_DIR"
  IMPORT_JSON=""
  if [ -n "$IMPORT_ROOT" ]; then
    IMPORT_JSON="[\"$IMPORT_ROOT\"]"
  else
    IMPORT_JSON='[]'
  fi
  umask 077
  cat >"$USER_JSON" <<EOF
{
  "apiBaseUrl": "$BASE_URL",
  "bearerToken": "$TOKEN",
  "localDataDir": "$LOCAL_DATA_DIR",
  "requestTimeoutMs": 10000,
  "maxPdfBytes": 104857600,
  "importRoots": $IMPORT_JSON
}
EOF
  chmod 600 "$USER_JSON"
  log "wrote $USER_JSON"
elif [ -n "$TOKEN" ] || [ -n "$LOCAL_DATA_DIR" ] || [ -n "$IMPORT_ROOT" ]; then
  log "keeping existing $USER_JSON (omit --token/--local-data-dir on upgrade)"
fi

detect_ide() {
  if [ -n "$IDE_OVERRIDE" ]; then
    printf '%s' "$IDE_OVERRIDE"
    return
  fi
  if [ -n "${QODER_AGENT:-}" ] || [ -n "${QODER_SESSION:-}" ]; then
    printf 'qoder'
    return
  fi
  if [ -n "${TRAE_SESSION:-}" ] || [ -n "${TRAE_IDE:-}" ]; then
    printf 'trae'
    return
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    PID=$$
    DEPTH=0
    while [ "$DEPTH" -lt 12 ] && [ "$PID" -gt 1 ]; do
      NAME="$(ps -o comm= -p "$PID" 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
      case "$NAME" in
        *workbuddy*) printf 'workbuddy'; return ;;
        *trae*) printf 'trae'; return ;;
        *qoder*) printf 'qoder'; return ;;
        *claude*) printf 'claude'; return ;;
        *cursor*) printf 'cursor'; return ;;
        *codex*) printf 'codex'; return ;;
      esac
      PID="$(ps -o ppid= -p "$PID" 2>/dev/null | tr -d ' ' || echo 0)"
      DEPTH=$((DEPTH + 1))
    done
  fi
  printf 'unknown'
}

merge_mcp_json() {
  local target_file="$1"
  local tmp="$TMP_DIR/mcp-merge.json"
  mkdir -p "$(dirname "$target_file")"
  python3 - "$target_file" "$tmp" "$NODE_BIN" "$ENTRY_JS" "$USER_JSON" "$MCP_ROOT/current/mcp-ui" "$TARGET_VERSION" <<'PY'
import json, os, sys
target, tmp, node, entry, user_json, ui_dir, version = sys.argv[1:8]
server = {
    "command": node,
    "args": [entry],
    "env": {
        "DENTALBOOK_USER_CONFIG": user_json,
        "DENTALBOOK_MCP_UI_DIR": ui_dir,
        "DENTALBOOK_MCP_VERSION": version,
    },
}
if os.path.isfile(target):
    with open(target, encoding="utf-8") as fh:
        data = json.load(fh)
else:
    data = {}
servers = data.setdefault("mcpServers", {})
servers["dentalbook-user"] = server
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
PY
  mv "$tmp" "$target_file"
  log "updated $target_file"
}

merge_claude_json() {
  local target_file="$1"
  local tmp="$TMP_DIR/claude-merge.json"
  mkdir -p "$(dirname "$target_file")"
  python3 - "$target_file" "$tmp" "$NODE_BIN" "$ENTRY_JS" "$USER_JSON" "$MCP_ROOT/current/mcp-ui" "$TARGET_VERSION" <<'PY'
import json, os, sys
target, tmp, node, entry, user_json, ui_dir, version = sys.argv[1:8]
server = {
    "command": node,
    "args": [entry],
    "env": {
        "DENTALBOOK_USER_CONFIG": user_json,
        "DENTALBOOK_MCP_UI_DIR": ui_dir,
        "DENTALBOOK_MCP_VERSION": version,
    },
}
if os.path.isfile(target):
    with open(target, encoding="utf-8") as fh:
        data = json.load(fh)
else:
    data = {}
servers = data.setdefault("mcpServers", {})
servers["dentalbook-user"] = server
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
PY
  mv "$tmp" "$target_file"
  log "updated $target_file"
}

write_host_to_user_json() {
  host="$1"
  case "$host" in
    workbuddy|trae|cursor|codex|claude|qoder) ;;
    *) return 0 ;;
  esac
  [ -f "$USER_JSON" ] || return 0
  python3 - "$USER_JSON" "$host" <<'PY'
import json, sys
path, host = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
data["host"] = host
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
PY
  log "set host=$host in $USER_JSON"
}

if [ "$WRITE_AUTO" -eq 1 ] || [ -n "$IDE_OVERRIDE" ]; then
  IDE="$(detect_ide)"
  write_host_to_user_json "$IDE"
fi

if [ "$WRITE_AUTO" -eq 1 ]; then
  case "$IDE" in
    workbuddy)
      merge_mcp_json "$HOME/.workbuddy/mcp.json"
      ;;
    trae)
      merge_mcp_json "$HOME/Library/Application Support/Trae/User/mcp.json"
      ;;
    qoder)
      merge_mcp_json "$HOME/.qoder/mcp.json"
      ;;
    claude)
      merge_claude_json "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
      ;;
    cursor)
      merge_mcp_json "$HOME/.cursor/mcp.json"
      ;;
    codex)
      merge_mcp_json "$HOME/.codex/mcp.json"
      ;;
    unknown)
      die "--write-auto could not detect IDE; pass --ide workbuddy|trae|claude|cursor|codex|qoder"
      ;;
    *)
      die "unsupported IDE: $IDE"
      ;;
  esac
  log "reload MCP in your IDE, then call system.health and library.stats"
fi

log "MCP user release ready at $MCP_ROOT/current (version $TARGET_VERSION)"
