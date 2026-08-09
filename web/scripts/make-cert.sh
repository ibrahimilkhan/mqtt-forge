#!/usr/bin/env bash
# Generates the dev server certificate used to serve the panel over HTTPS on this machine's
# own addresses, so a phone on the same network can reach it in a secure context. Both the
# Bonjour name and the IP are baked in, so rerun this after renaming the machine or moving
# to a network that hands out a different address.
set -euo pipefail

cd "$(dirname "$0")/.."

ip="${1:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"
if [ -z "$ip" ]; then
  echo "Could not detect a LAN address. Pass one explicitly: npm run cert -- 192.168.1.42" >&2
  exit 1
fi

# The Bonjour name is the nicer address to type on a phone and survives a DHCP lease change,
# so it goes in alongside the IP rather than instead of it.
bonjour="$(scutil --get LocalHostName 2>/dev/null || true)"
names="DNS:localhost,IP:127.0.0.1,IP:$ip"
if [ -n "$bonjour" ]; then
  names="DNS:$bonjour.local,$names"
fi

mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/dev-key.pem -out certs/dev-cert.pem \
  -days 825 -subj "/CN=MQTTForge dev" \
  -addext "subjectAltName=$names" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null

echo "Certificate written for $names."
if [ -n "$bonjour" ]; then
  echo "Start the dev server and open https://$bonjour.local:5173/ on the phone."
else
  echo "Start the dev server and open https://$ip:5173/ on the phone."
fi
