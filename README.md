# MQTTForge

[![Release](https://img.shields.io/github/v/release/ibrahimilkhan/mqtt-forge?color=1e40af&label=release)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest)
[![Image](https://img.shields.io/badge/ghcr.io-mqtt--forge-1e40af?logo=docker&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/pkgs/container/mqtt-forge)
[![Licence](https://img.shields.io/github/license/ibrahimilkhan/mqtt-forge?color=1e40af)](LICENSE)

An MQTT test console: connect to a broker, watch topics as they arrive, and publish
messages by hand. A .NET API drives an MQTT client and pushes what it receives to a React
interface over SignalR.

MQTTForge connects to a broker you already run — it is not a broker itself.

![The console: a broker's topics as a live tree, every frame on the wire, and a publish form](.github/assets/console.png)

## Download

[![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-macos-arm64.dmg)
[![macOS Intel](https://img.shields.io/badge/macOS-Intel-555555?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-macos-x64.dmg)
[![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-windows-x64.zip)
[![Linux x64](https://img.shields.io/badge/Linux-x64-1e40af?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-linux-x64.tar.gz)

Each button downloads the newest release, so they stay valid as versions come and go. Or run
it as a container, which needs nothing installed and asks for no permissions:

```
docker run -d -p 5169:5169 ghcr.io/ibrahimilkhan/mqtt-forge
```

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

## Colouring topics

The **Colours** panel takes a list of MQTT filters and a colour for each — `sensors/+/temp`,
`alerts/#`, whatever you watch for. Every topic a rule covers is then marked with a dot of that
colour in the topic tree and in the log, so a branch you care about is findable in a tree of
hundreds without reading paths.

When two rules cover one topic, the more specific filter wins: read left to right, a named
segment beats `+`, and `+` beats `#`. So `sensors/#` can colour a whole subtree while
`sensors/+/temp` picks the temperatures out of it. Editing a rule recolours what is already on
screen, history included.

The rules are stored by the API rather than in the browser, so a phone opened from the QR panel
sees the same colours.

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
network — that is what the QR panel's code is for. On a shared network anyone who
can reach the port can publish to your broker.

Saved connection settings live inside the container and are lost on `docker rm`. To keep
them, point the app at a mounted volume instead:

```
docker run -d -p 5169:5169 \
  -e MqttForge__SettingsPath=/data/connection-settings.json \
  -v mqtt-forge-data:/data \
  --name mqtt-forge mqtt-forge
```

The colour rules follow the settings into that directory, so one mount keeps both.
`MqttForge__ColourRulesPath` overrides where they land if you want them somewhere else.

## Desktop app

```
./scripts/package-macos.sh
```

Produces `dist/MQTTForge-macos-arm64.dmg`; pass `osx-x64` for the Intel slice. The build is unsigned, so the first launch needs
right-click → Open rather than a double-click.

Like the Docker image, the desktop app binds `0.0.0.0` — it is reachable from other
devices on the same network, which is what the QR panel's code is for, and equally
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
