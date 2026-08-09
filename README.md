# MQTTForge

An MQTT test console: connect to a broker, watch topics as they arrive, and publish
messages by hand. A .NET API drives an MQTT client and pushes what it receives to a React
interface over SignalR.

MQTTForge connects to a broker you already run — it is not a broker itself.

## Download

Every link below always points at the newest release, so they stay valid as versions come and go.

| Platform | |
| --- | --- |
| macOS (Apple Silicon) | [MQTTForge-macos-arm64.dmg](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-macos-arm64.dmg) |
| macOS (Intel) | [MQTTForge-macos-x64.dmg](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-macos-x64.dmg) |
| Windows (x64) | [MQTTForge-windows-x64.zip](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-windows-x64.zip) |
| Linux (x64) | [MQTTForge-linux-x64.tar.gz](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-linux-x64.tar.gz) |
| Docker | `docker pull ghcr.io/ibrahimilkhan/mqtt-forge:latest` |

The desktop builds carry no paid signing certificate, so each platform asks once before it
trusts them.

**macOS.** Drag MQTTForge to Applications and eject the disk image — launching it from the
image itself is refused. The first launch is then blocked as unverified: allow it under System
Settings → Privacy & Security → Open Anyway, or right-click → Open on older releases. If macOS
still refuses, clear the download flag by hand:

```
xattr -dr com.apple.quarantine /Applications/MQTTForge.app
```

**Windows.** SmartScreen needs More info → Run anyway.

**Linux.** The window is drawn by WebKitGTK, so install `libwebkit2gtk-4.1-0` (Debian and
Ubuntu) if the app starts and no window appears.

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

Produces `dist/MQTTForge-macos-arm64.dmg`; pass `osx-x64` for the Intel slice. The build is unsigned, so the first launch needs
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

## Licence

AGPL-3.0.
