#!/usr/bin/env bash
#
# Starts the broker lab and prints what is now listening. Everything is local, anonymous unless
# the table says otherwise, and safe to leave running — `./down.sh` puts it away.
set -euo pipefail
cd "$(dirname "$0")"

./make-certs.sh > /dev/null
docker compose -f compose.yml up -d --wait --wait-timeout 120 || docker compose -f compose.yml up -d

cat <<'TABLE'

  MQTTForge broker lab — everything below is on localhost

  broker         scheme  port   versions        notes
  ------------------------------------------------------------------------------------
  Mosquitto 2    mqtt    21883  3.1 3.1.1 5.0   anonymous
  Mosquitto 2    mqtt    21884  3.1 3.1.1 5.0   forge / forge-secret
  Mosquitto 2    mqtts   28883  3.1 3.1.1 5.0   needs certs/ca.crt as the extra CA
  Mosquitto 2    mqtts   28884  3.1 3.1.1 5.0   also needs certs/client.pfx, password "forge"
  Mosquitto 2    mqtts   28885  3.1 3.1.1 5.0   certificate expired in 2020, on purpose
  Mosquitto 2    mqtts   28886  3.1 3.1.1 5.0   certificate is for another name, on purpose
  Mosquitto 2    ws      29001  3.1 3.1.1 5.0   any path
  Mosquitto 2    wss     29443  3.1 3.1.1 5.0   any path, needs certs/ca.crt
  Mosquitto 1.5  mqtt    31883  3.1 3.1.1       predates MQTT 5, and refuses it
  EMQX 5.8       mqtt    41883  3.1 3.1.1 5.0   anonymous
  EMQX 5.8       mqtts   48883  3.1 3.1.1 5.0   EMQX's own certificate; untrusted here
  EMQX 5.8       ws      48083  3.1 3.1.1 5.0   path /mqtt, and only /mqtt
  EMQX 5.8       wss     48084  3.1 3.1.1 5.0   path /mqtt, untrusted certificate
  HiveMQ CE      mqtt    51883  3.1.1 5.0       anonymous
  HiveMQ CE      ws      58000  3.1.1 5.0       path /mqtt

  Certificates: scripts/brokers/certs — ca.crt to trust the lab, client.pfx for 28884.

TABLE
