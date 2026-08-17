# MQTTForge

[![Release](https://img.shields.io/github/v/release/ibrahimilkhan/mqtt-forge?color=1e40af&label=release)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest)
[![Image](https://img.shields.io/badge/ghcr.io-mqtt--forge-1e40af?logo=docker&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/pkgs/container/mqtt-forge)
[![Licence](https://img.shields.io/github/license/ibrahimilkhan/mqtt-forge?color=1e40af)](LICENSE)

An open-source MQTT test console: connect to a broker, watch topics as they arrive, and publish
messages by hand. A .NET API drives an MQTT client and pushes what it receives to a React
interface over SignalR.

MQTTForge connects to a broker you already run — it is not a broker itself.

![The console: a broker's topics as a live tree, every frame on the wire, and a publish form](.github/assets/console.png)

## Download

[![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-macos-arm64.dmg)
[![macOS Intel](https://img.shields.io/badge/macOS-Intel-555555?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-macos-x64.dmg)
[![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-windows-x64.zip)
[![Linux x64](https://img.shields.io/badge/Linux-x64-1e40af?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-linux-x64.tar.gz)

Each button downloads the newest release, so they stay valid as versions come and go. Or run it
as a container, which installs nothing and asks for no permissions:

```
docker run -d -p 5169:5169 ghcr.io/ibrahimilkhan/mqtt-forge
```

<details>
<summary>The desktop builds are unsigned, so each platform asks once</summary>

Signing needs a paid certificate this project does not carry. **The Docker image is the way
around all of it** — a container has no signature to check.

**macOS.** Drag MQTTForge to Applications and eject the disk image; launching it from the image
is refused. The first launch is then blocked with *"Apple could not verify MQTTForge.app is free
of malware"* — that only means the app was never sent to Apple for notarisation, not that
anything was found in it. On macOS 15 and later, System Settings → Privacy & Security → **Open
Anyway**. On macOS 14 and earlier, right-click → Open. Either way it is asked once. Clearing the
download flag skips the prompt entirely:

```
xattr -dr com.apple.quarantine /Applications/MQTTForge.app
```

**Windows.** SmartScreen needs More info → Run anyway.

**Linux.** The window is drawn by WebKitGTK, so install `libwebkit2gtk-4.1-0` (Debian and Ubuntu)
if the app starts and no window appears.
</details>

## What it does

- **Topic tree** — the broker's topology as it builds, with the latest payload on every branch.
- **Wire log** — every frame in and out, each row carrying its time, direction, QoS and size.
- **Publish** — text, JSON or hex, with QoS and the retained flag; any logged message reloads
  into the form for a resend.
- **Filters** — subscribe to one or a list at a time, batched into a couple of round trips.
- **Colour rules** — MQTT filters you pick colours for, so a branch stands out in a tree of
  hundreds.
- **QR panel** — opens the same console on a phone on your network.

## Colouring topics

The **Colours** panel takes a list of MQTT filters and a colour for each — `sensors/+/temp`,
`alerts/#`, whatever you watch for. Every topic a rule covers is then drawn in that colour, in
the tree and in the log, with the row's left edge carrying it too.

When two rules cover one topic the more specific filter wins: read left to right, a named
segment beats `+`, and `+` beats `#`. So `sensors/#` can colour a whole subtree while
`sensors/+/temp` picks the temperatures out of it. Editing a rule recolours what is already on
screen, history included.

The rules live with the API rather than in the browser, so a phone opened from the QR panel sees
the same colours.

## Roadmap

Planned, in rough order:

- **Automation** — scripted sequences of publishes and expected replies, so a scenario can be
  replayed instead of clicked through.
- **Recording** — capture a session's traffic to a file and play it back.
- **Load testing** — many clients and sustained publish rates, to see how a broker holds up.

Ideas and gaps are always welcome — [open an
issue](https://github.com/ibrahimilkhan/mqtt-forge/issues) for anything missing, broken or worth
doing differently. Pull requests are welcome too.

## Development

Needs .NET 10 and Node 22+. The API and the interface run as two processes:

```
dotnet run --project src/MqttForge.Api    # http://localhost:5169
npm --prefix web run dev                  # http://localhost:5173
```

Open http://localhost:5173. Vite proxies `/api` and `/hubs` through to the API, so the browser
stays on one origin and CORS never enters the picture.

Tests:

```
dotnet test                    # unit and integration
npm --prefix web test          # interface
```

The MQTT integration tests start a Mosquitto container, so they need Docker running. The rest of
the suite does not.

## Building

```
dotnet publish -c Release
```

A Release build compiles the interface into `src/MqttForge.Api/wwwroot` — generated output, not
tracked — so the published application serves everything from one process on one port.
`dotnet build -c Debug` skips the npm step to keep backend iteration fast; `-p:SkipFrontend=true`
skips it in Release too.

For the macOS desktop app, `./scripts/package-macos.sh` produces
`dist/MQTTForge-macos-arm64.dmg`; pass `osx-x64` for the Intel slice. Windows and Linux packaging
is not scripted yet — both need to run on their own platform.

## Docker

Every release is published to GHCR for amd64 and arm64, so this pulls whichever matches:

```
docker run -d -p 5169:5169 --name mqtt-forge ghcr.io/ibrahimilkhan/mqtt-forge
```

To build from this checkout instead: `docker build -t mqtt-forge .`. Either way the console is at
http://localhost:5169, and `docker stop mqtt-forge` ends it.

Settings live inside the container and are lost on `docker rm`. To keep them, mount a volume —
the colour rules follow the settings into that directory, so one mount holds both:

```
docker run -d -p 5169:5169 \
  -e MqttForge__SettingsPath=/data/connection-settings.json \
  -v mqtt-forge-data:/data \
  --name mqtt-forge ghcr.io/ibrahimilkhan/mqtt-forge
```

> **On a shared network.** The container and the desktop app both bind `0.0.0.0` — that is what
> makes the QR panel work, and it equally means anyone who can reach the port can publish to your
> broker.

## Layout

| Path | What lives there |
|---|---|
| `src/MqttForge.Domain` | Models and the abstractions the other layers implement |
| `src/MqttForge.Application` | Use cases, one service per capability |
| `src/MqttForge.Infrastructure` | MQTTnet client, local settings storage |
| `src/MqttForge.Api` | Controllers, SignalR hub, composition root |
| `web` | React + TypeScript interface |

## Licence

[AGPL-3.0](LICENSE).
