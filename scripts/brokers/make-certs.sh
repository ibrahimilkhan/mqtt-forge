#!/usr/bin/env bash
#
# A private CA, server certificates for localhost and a client certificate, for the TLS
# listeners in compose.yml. Everything here is a throwaway meant to stay under scripts/brokers/
# and never leave this machine: the CA key sits next to the certificates it signed.
#
# Run inside a container rather than against the host's openssl. macOS ships LibreSSL, which
# rejects half of what is asked for below, and the point of a certificate fixture is that
# everyone running the tests gets the same bytes.
#
# Idempotent — re-run it once the certificates expire, which the good ones do in ten years.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f certs/ca.crt && -f certs/server.crt && -f certs/client.pfx ]]; then
  echo "certificates already present — delete scripts/brokers/certs to regenerate"; exit 0
fi

mkdir -p certs
# Any image with a real OpenSSL will do; this one is already pulled because it is one of the
# brokers the lab runs.
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD/certs:/certs" -w /certs \
  --entrypoint sh emqx/emqx:5.8 -euc '
set -e

# The CA the console is pointed at with "Extra CA certificate", and the one the broker checks
# client certificates against on the mutual-TLS listener.
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 3650 \
  -subj "/CN=MQTTForge Test CA" 2>/dev/null

# Server. The names here are what makes localhost validate — and what a certificate-name test
# fails against by dialling 127.0.0.1 on a listener whose certificate omits the address.
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
printf "subjectAltName=DNS:localhost,DNS:mosquitto2,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt \
  -days 3650 -extfile server.ext 2>/dev/null

# Same CA, but issued to a name nothing will be dialled by: this is the certificate the
# name-mismatch listener presents, so the console has to name the mismatch rather than
# blame the trust chain.
openssl req -newkey rsa:2048 -nodes -keyout wrongname.key -out wrongname.csr \
  -subj "/CN=not-this-broker.invalid" 2>/dev/null
printf "subjectAltName=DNS:not-this-broker.invalid\nextendedKeyUsage=serverAuth\n" > wrongname.ext
openssl x509 -req -in wrongname.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out wrongname.crt \
  -days 3650 -extfile wrongname.ext 2>/dev/null

# One that was valid and is not any more. openssl x509 cannot backdate before 3.5, so this goes
# through openssl ca, which has taken -startdate and -enddate for far longer.
openssl req -newkey rsa:2048 -nodes -keyout expired.key -out expired.csr -subj "/CN=localhost" 2>/dev/null
printf "[ca]\ndefault_ca=d\n[d]\ndir=.\ndatabase=index.txt\nserial=serial\nnew_certs_dir=.\ndefault_md=sha256\npolicy=p\nunique_subject=no\n[p]\ncommonName=supplied\n" > ca.cnf
: > index.txt; echo 01 > serial
openssl ca -batch -config ca.cnf -cert ca.crt -keyfile ca.key -in expired.csr -out expired.crt \
  -startdate 20200101000000Z -enddate 20200201000000Z -extfile server.ext -notext 2>/dev/null

# Client, for the mutual-TLS listener. Written as PEM and as PKCS#12 because the console takes
# either, and a .pfx with a password is the shape a cloud broker hands you.
openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr \
  -subj "/CN=mqttforge-client" 2>/dev/null
printf "extendedKeyUsage=clientAuth\n" > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt \
  -days 3650 -extfile client.ext 2>/dev/null
openssl pkcs12 -export -out client.pfx -inkey client.key -in client.crt -passout pass:forge 2>/dev/null

# A client certificate the broker will not accept: correctly formed, signed by nobody it knows.
openssl req -x509 -newkey rsa:2048 -nodes -keyout stranger.key -out stranger.crt -days 3650 \
  -subj "/CN=stranger" 2>/dev/null
openssl pkcs12 -export -out stranger.pfx -inkey stranger.key -in stranger.crt -passout pass: 2>/dev/null

rm -f ./*.csr ./*.ext ca.cnf index.txt* serial* ./*.pem
chmod 644 ./*.key ./*.crt ./*.pfx
'
ls -1 certs
