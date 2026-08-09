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
| Docker | `docker run -d -p 5169:5169 ghcr.io/ibrahimilkhan/mqtt-forge` |

The desktop builds carry no paid signing certificate, so each platform asks once before it
trusts them. **The Docker image is the way around all of it** — a container carries no
signature check, so `docker run` starts with nothing to dismiss.

**macOS.** Drag MQTTForge to Applications and eject the disk image; launching it from the image
itself is refused. The first launch is then blocked with *"Apple could not verify MQTTForge.app
is free of malware"*. That wording sounds alarming but only means the app was never sent to
Apple for notarisation, which costs a paid developer account — it is not a finding about the
app. To get past it on macOS 15 and later, open System Settings → Privacy & Security, scroll to
Security, and use **Open Anyway** next to the blocked-app line, then confirm. On macOS 14 and
earlier, right-click → Open does the same job. Either way it is asked once, not every launch.

Clearing the download flag by hand skips the prompt entirely:

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

Every release is published to GHCR for both amd64 and arm64, so this pulls whichever matches
the machine:

```
docker run -d -p 5169:5169 --name mqtt-forge ghcr.io/ibrahimilkhan/mqtt-forge
```

To build the image from this checkout instead:

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
