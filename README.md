# MQTTForge

[![Release](https://img.shields.io/github/v/release/ibrahimilkhan/mqtt-forge?color=0e4260&label=release)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest)
[![Image](https://img.shields.io/badge/ghcr.io-mqtt--forge-0e4260?logo=docker&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/pkgs/container/mqtt-forge)
[![Licence](https://img.shields.io/github/license/ibrahimilkhan/mqtt-forge?color=0e4260)](LICENSE)

An open source MQTT test tool. Connect to a broker, watch what it carries, chart it, and publish
back. It is small and fast, and it runs on macOS, Windows, Linux and Docker.

MQTTForge talks to a broker you already run. It is not a broker itself.

![The console watching a home broker: the topic tree in the middle with the latest value on every
topic, the newest message and its chart on the right, and the publish form under
them](.github/assets/console.png)

## What it does

- **Topic tree** — every topic the broker carries, with its latest value beside it.
- **Log** — the newest message on whatever you pick, with its time, QoS and size, and the history
  behind it one click away.
- **Charts** — a topic that sends numbers gets a chart of its run, and a short summary under it:
  the mean, the spread, where it stepped, whether it repeats. A JSON body's numbers are each
  chartable by name.
- **Messages** — open one message in its own window. A JSON body becomes a document you can fold,
  with an index of what is in it down the side.
- **Publish** — text, JSON or hex, with QoS and the retained flag. Any message in the log loads
  back into the form.
- **Colour rules** — give an MQTT filter a colour and every topic it covers wears it.
- **Filters, QR, settings** — subscribe to a list of filters, open the same session on your phone,
  and set the fonts and sizes.

## Get it

[![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-macos-arm64.dmg)
[![macOS Intel](https://img.shields.io/badge/macOS-Intel-555555?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-macos-x64.dmg)
[![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-windows-x64.zip)
[![Linux x64](https://img.shields.io/badge/Linux-x64-0e4260?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-linux-x64.tar.gz)

Or run it as a container and open http://localhost:5169:

```
docker run -d -p 5169:5169 --name mqtt-forge ghcr.io/ibrahimilkhan/mqtt-forge
```

Then put your broker's address in the panel that opens. `mqtts://host:8883` can be pasted whole —
the port, the way in and the TLS box sort themselves out.

<details>
<summary>The desktop builds are not signed, so each system asks once</summary>

Signing needs a paid certificate this project does not have. The Docker image has no signature to
check, so it never asks.

- **macOS** — drag the app to Applications, then System Settings → Privacy & Security → **Open
  Anyway** (macOS 15+), or right-click → Open (macOS 14 and earlier). Or run
  `xattr -dr com.apple.quarantine /Applications/MQTTForge.app`.
- **Windows** — SmartScreen: More info → Run anyway.
- **Linux** — install `libwebkit2gtk-4.1-0` if the app starts and no window appears.

</details>

<details>
<summary>Running the container next to your broker</summary>

Inside a container, `localhost` means the container. Use your broker's hostname or IP; for a
broker on the same machine but outside Docker, use `host.docker.internal` (on Linux, add
`--add-host=host.docker.internal:host-gateway`).

Certificates are read where the server runs, so mount them and give the panel the path inside:

```
docker run -d -p 5169:5169 -v ~/certs:/certs:ro ghcr.io/ibrahimilkhan/mqtt-forge
```

To keep settings and colour rules across `docker rm`, name a settings file on a volume:

```
docker run -d -p 5169:5169 \
  -e MqttForge__SettingsPath=/data/connection-settings.json \
  -v mqtt-forge-data:/data \
  --name mqtt-forge ghcr.io/ibrahimilkhan/mqtt-forge
```

The desktop app needs none of this — it keeps its files in the normal per-user folder.

> Both the container and the desktop app listen on all interfaces, which is what makes the QR
> panel work. On a shared network, publish the port as `-p 127.0.0.1:5169:5169` to keep it to your
> own machine. The broker password is stored as plain text in the settings file.

</details>

## Connecting

MQTTForge speaks **MQTT 5.0, 3.1.1 and 3.1**, over **`mqtt://`, `mqtts://`, `ws://` and `wss://`**.
You are never asked which version — it offers 5.0 first and keeps whatever the broker accepts.

Everything a cloud broker needs is under **Encryption**: a client certificate, an extra CA, a
server name, an ALPN protocol. Most brokers need none of it. In the desktop app a **Choose…**
button opens your own file dialog for each certificate.

When a connection fails, the panel says which of about thirty things went wrong and what to do —
the WebSocket path rather than the port, your certificate rather than the broker's.

## Reading one message

Double-click a message and it opens in its own window. A JSON body is drawn as a document you can
fold branch by branch, with an index down the left saying what is inside each key. The mark in the
corner copies exactly what arrived, and Ctrl+A selects the whole message.

![One gateway message opened in a window: the index down the left lists the seven things in it,
with the document beside it](.github/assets/message.png)

## Charts

A topic that sends numbers is a measurement, and the latest value alone leaves the arithmetic to
your eye. Pick one and MQTTForge draws the run and says what it adds up to: how many readings,
the mean and the middle, the spread, where the run stepped to a new level, whether it repeats, and
which readings do not belong.

It reads the kind of run first. A room temperature gets a mean and a trend. A door sensor or a
pump gets counted and timed instead, because the average of a door is a number the door has never
been. A meter that only climbs gets the rate it climbs at.

Four chips over the plot set how much height goes on the range — **auto**, **ends**, **mid**,
**log** — and readings outside the range are drawn on the edge and counted, never dropped.
**time** and **dist** read the same run in order or as a distribution, and **csv** saves it.

Open a chart as a window and pin it, and it keeps the topic it was opened on while you use the
rest of the console. Two windows side by side compare two runs.

![Two chart windows over the console, each holding the topic it was opened
on](.github/assets/windows.png)

## Colouring topics

Give the **Colours** panel a list of MQTT filters and a colour for each — `sensors/+/temp`,
`alerts/#` — and every topic a rule covers is drawn in that colour, in the tree and in the log.
When two rules cover one topic, the more exact filter wins.

![The Colours panel with two rules, and the tree they paint](.github/assets/colours.png)

## What it costs

Measured on a live tram feed, in the console's own health line:

| Holding | Taking it in | Drawing |
| --- | --- | --- |
| 128k messages · 6.7k topics · 36.8 MB | 1 ms per second | 47 fps |

Messages reach the interface a frame at a time, up to about 120k a second, so a burst fills the
log instead of freezing the window. The log keeps half a million messages and drops the oldest.

## Next

- **Automation** — run a scripted sequence of publishes and expected replies.
- **Recording** — save a session's traffic and play it back.
- **Load testing** — many clients at a sustained rate, to see how a broker holds up.

## Build it yourself

Needs .NET 10 and Node 22+.

```
dotnet run --project src/MqttForge.Api    # http://localhost:5169
npm --prefix web run dev                  # http://localhost:5173
```

`dotnet publish -c Release` builds the interface into the API and serves it all from one port.
[CONTRIBUTING.md](CONTRIBUTING.md) covers the rest: tests, packaging, and where each layer lives.

## Ideas are welcome

Anything missing or broken — [open an
issue](https://github.com/ibrahimilkhan/mqtt-forge/issues). One sentence is enough.

## Licence

[AGPL-3.0](LICENSE).
