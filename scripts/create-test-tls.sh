#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ] || [ "$1" = "/" ]; then
  echo "Usage: ./scripts/create-test-tls.sh /absolute/test-library-root" >&2
  exit 2
fi

TLS_DIR="$1/secrets/tls"
if [ -e "$TLS_DIR/ca.crt" ] || [ -e "$TLS_DIR/server.crt" ] || [ -e "$TLS_DIR/server.key" ]; then
  echo "TLS files already exist; refusing to replace them." >&2
  exit 1
fi

mkdir -p "$TLS_DIR"
openssl genrsa -out "$TLS_DIR/ca.key" 4096
openssl req -x509 -new -sha256 -days 3650 \
  -key "$TLS_DIR/ca.key" \
  -subj "/CN=Dentalbook Test Center CA" \
  -out "$TLS_DIR/ca.crt"
openssl genrsa -out "$TLS_DIR/server.key" 3072
openssl req -new \
  -key "$TLS_DIR/server.key" \
  -subj "/CN=127.0.0.1" \
  -out "$TLS_DIR/server.csr"

EXT_FILE="$TLS_DIR/server.ext"
trap 'rm -f "$EXT_FILE"' EXIT HUP INT TERM
{
  echo "basicConstraints=critical,CA:FALSE"
  echo "keyUsage=critical,digitalSignature,keyEncipherment"
  echo "extendedKeyUsage=serverAuth"
  echo "subjectAltName=IP:127.0.0.1,DNS:localhost"
} > "$EXT_FILE"

openssl x509 -req -sha256 -days 825 \
  -in "$TLS_DIR/server.csr" \
  -CA "$TLS_DIR/ca.crt" \
  -CAkey "$TLS_DIR/ca.key" \
  -CAcreateserial \
  -extfile "$EXT_FILE" \
  -out "$TLS_DIR/server.crt"
chmod 600 "$TLS_DIR/ca.key" "$TLS_DIR/server.key"
chmod 644 "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt"
echo "Created loopback-only test TLS material under $TLS_DIR"
