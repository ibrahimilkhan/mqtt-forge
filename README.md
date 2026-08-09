# MQTTForge

An MQTT test console: connect to a broker, watch topics as they arrive, and publish
messages by hand. A .NET API drives an MQTT client and pushes what it receives to a React
interface over SignalR.

MQTTForge connects to a broker you already run — it is not a broker itself.

## Requirements

- .NET 10
- Node 22+ (only to build the interface)

## Development

The API and the interface run as two processes:

```
dotnet run --project src/MqttForge.Api      # http://localhost:5169
npm --prefix web run dev                  # http://localhost:5173
```

Open http://localhost:5173. Vite proxies `/api` and `/hubs` through to the API, so the
browser stays on one origin and CORS never enters the picture.

## Building

```
dotnet publish -c Release
```

A Release build compiles the interface into `src/MqttForge.Api/wwwroot`, so the published
application serves everything from a single process on a single port. `dotnet build -c Debug`
skips the npm step, which keeps backend iteration fast; pass `-p:SkipFrontend=true` to skip
it in Release too.

`src/MqttForge.Api/wwwroot` is generated output and is not tracked.

## Docker

```
docker build -t mqtt-forge .
docker run -d -p 5169:5169 --name mqtt-forge mqtt-forge
```

Open http://localhost:5169. Stop it with `docker stop mqtt-forge`.

The container binds `0.0.0.0`, so the panel is reachable from other devices on the same
network — that is what the Mobile panel's QR code is for. On a shared network anyone who
can reach the port can publish to your broker.

Saved connection settings live inside the container and are lost on `docker rm`. To keep
them, point the app at a mounted volume instead:

```
docker run -d -p 5169:5169 \
  -e MqttForge__SettingsPath=/data/connection-settings.json \
  -v mqtt-forge-data:/data \
  --name mqtt-forge mqtt-forge
```

## Desktop app

```
./scripts/package-macos.sh
```

Produces `dist/MQTTForge.dmg`. The build is unsigned, so the first launch needs
right-click → Open rather than a double-click.

Like the Docker image, the desktop app binds `0.0.0.0` — it is reachable from other
devices on the same network, which is what the Mobile panel's QR code is for, and equally
means anyone on a shared network who can reach it can publish to your broker.

Windows (`.exe`) and Linux (AppImage) packaging is not scripted yet; both need to run on
their own platform.

## Tests

```
dotnet test                    # unit and integration
npm --prefix web test          # interface
```

The MQTT integration tests start a Mosquitto container, so they need Docker running. The
rest of the suite does not.

## Layout

| Path | What lives there |
|---|---|
| `src/MqttForge.Domain` | Models and the abstractions the other layers implement |
| `src/MqttForge.Application` | Use cases, one service per capability |
| `src/MqttForge.Infrastructure` | MQTTnet client, local settings storage |
| `src/MqttForge.Api` | Controllers, SignalR hub, composition root |
| `web` | React + TypeScript interface |
| `docs/superpowers` | Design specs and implementation plans |

## Licence

AGPL-3.0.
