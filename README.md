# MQTTForge

[![Release](https://img.shields.io/github/v/release/ibrahimilkhan/mqtt-forge?color=1e40af&label=release)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest)
[![Image](https://img.shields.io/badge/ghcr.io-mqtt--forge-1e40af?logo=docker&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/pkgs/container/mqtt-forge)
[![Licence](https://img.shields.io/github/license/ibrahimilkhan/mqtt-forge?color=1e40af)](LICENSE)

An open-source MQTT test console: connect to a broker, watch topics as they arrive, and publish.
The broker connection is held by the server rather than by the browser, so every device you point
at it — your desktop, or a phone from the QR panel — is working one connection, one set of
subscriptions and one set of colour rules.

MQTTForge connects to a broker you already run — it is not a broker itself.

![The console connected to a broker: the topic tree in the middle with alert and device branches
in their rule colours, the wire log on the right showing time, direction, QoS and size on every
row, and the publish form below it](.github/assets/console.png)

## What it does

- **Topic tree** — the broker's topology as it builds, each topic showing its own latest payload.
- **Wire log** — the newest message on whatever you pick, one branch or the whole broker,
  stamped with its time, QoS and size, with the history behind it a click away.
- **Readings, not just messages** — a topic sending numbers gets a chart of its run, and under
  it what that run adds up to: mean, median, spread, range, the readings that fall outside the
  fences, which way it is drifting, how often it arrives, and whether the whole thing has a
  shape with a name. A JSON body's fields are each chartable by name.
- **Publish** — text, JSON or hex, with QoS and the retained flag; any logged message reloads
  into the form for a resend.
- **Filters** — connecting subscribes to `#` unless you clear the box, so the tree fills on its
  own; narrow it to one filter or a list when a busy broker makes that too much.
- **Colour rules** — MQTT filters you pick colours for, so a branch stands out in a tree of
  hundreds.
- **QR panel** — opens the same console on a phone on your network.

It speaks MQTT 5.0 only, over TCP or TLS, with a username and password if the broker wants them.
A broker that speaks just 3.1.1 refuses the connection.

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

> **On a shared network.** The container and the desktop app both bind `0.0.0.0` — that is what
> makes the QR panel work, and it equally means anyone who can reach the port can publish to your
> broker. Publishing the container's port as `-p 127.0.0.1:5169:5169` keeps it to this machine,
> and gives up the QR panel along with it.

## Running it with Docker

**1. Start it.** One image covers amd64 and arm64, so this is the same line on an Intel box and
on Apple Silicon:

```
docker run -d -p 5169:5169 --name mqtt-forge ghcr.io/ibrahimilkhan/mqtt-forge
```

**2. Open http://localhost:5169.** The console loads with the Broker panel already open.

**3. Point it at your broker** — fill in the host and port, then **Connect**. Which host depends
on where the broker runs:

| Your broker runs | Host to enter |
|---|---|
| On another machine | Its hostname or IP |
| In another container | That container's name, with both on one `--network` |
| On this machine, outside Docker | `host.docker.internal` — **not** `localhost` |

`localhost` inside a container means the container itself, which is why the last row needs the
special name. On Docker Desktop it works as-is; on Linux add
`--add-host=host.docker.internal:host-gateway` to the run command above.

<details>
<summary>No broker to hand? Start one alongside it</summary>

```
docker network create mqtt-forge
docker run -d --name broker --network mqtt-forge eclipse-mosquitto:2
```

Add `--network mqtt-forge` to the run command in step 1, then connect to host `broker`, port
1883. The two containers reach each other by name, so the broker needs no published port of its
own — which is the point, as it would otherwise be an anonymous broker on every interface.
</details>

**4. Watch it fill.** Leave *Subscribe to every topic on connect* ticked and the topic tree
builds as messages arrive. To be choosier, use the **Filters** panel — it takes one filter per
line, so a whole list subscribes at once.

**5. Read one branch.** Click a node in the tree and the log beside it narrows to that subtree.
If the topic sends numbers, the chart under the newest reading draws the run and the note under
that says what it adds up to. **hold** freezes the pane while you read it, without stopping the
log behind it; **csv** takes the readings away with you.

**6. Send one.** The publish form takes a topic, a payload as text, JSON or hex, a QoS and the
retained flag. Clicking any logged message loads it back into the form to send again.

**7. Stop and start.** `docker stop mqtt-forge` and `docker start mqtt-forge` keep everything;
`docker rm` throws the settings away, which the next section is about.

## Colouring topics

The **Colours** panel takes a list of MQTT filters and a colour for each — `sensors/+/temp`,
`alerts/#`, whatever you watch for. Every topic a rule covers is then drawn in that colour, in
the tree and in the log, with the row's left edge carrying it too.

![The Colours panel holding three rules beside the tree they paint: sensors/+/temp in purple
picks the temperatures out of the sensor branches, alerts/# colours that whole subtree red, and
devices/# colours its own in teal](.github/assets/colours.png)

When two rules cover one topic the more specific filter wins: read left to right, a named
segment beats `+`, and `+` beats `#`. So `sensors/#` can colour a whole subtree while
`sensors/+/temp` picks the temperatures out of it. Editing a rule recolours what is already on
screen, history included, and the rules live with the API rather than in the browser, so a phone
opened from the QR panel sees the same colours.

## Reading a sensor

A topic whose messages are numbers is a measurement, and a console that only shows you the
latest one leaves the arithmetic to your eye — which is the arithmetic an eye is worst at. Pick
such a topic and the pane draws its run, and writes what the run adds up to underneath:

- **How many, and where the middle is** — count, mean, median, standard deviation and range,
  with the quartiles a hover away.
- **What does not belong** — readings outside Tukey's fences are ringed on the line and counted
  in the note.
- **Where it is going** — a least-squares trend, but only when the drift is larger than the
  readings' own spread; anything smaller is a line through a cloud.
- **Where it stepped** — a valve opening or a heater coming on moves a run from one level to
  another, and the mean of such a run is a number that never happened. The split that best
  divides the run is reported when the two levels clear the scatter about them *and* explain the
  readings better than one straight line does, with a mark on the line at the moment it happened.
- **What shape it is** — a Kolmogorov–Smirnov test at five per cent against a normal, uniform or
  exponential distribution, with the parameters estimated from the readings themselves. Under
  twelve readings it says nothing, because every shape fits anything.
- **Whether it repeats itself** — a thermostat, a pump or a compressor cycles, and a cycling
  sensor has an ordinary mean, an ordinary spread and no trend at all, so nothing else would say
  so. The period comes from the run's autocorrelation, with the trend taken out first.
- **How often it arrives, and when it stops** — the middle gap between arrivals and how far the
  gaps stray from it. A topic that had a rhythm and has fallen three periods behind it is
  marked **silent**, which is the one thing here worth interrupting for.

One message can carry a whole environment, so a JSON body's numeric fields are offered by name —
`temp`, `env.hum`, `cells.0` — and the pane opens on whichever of them is doing the most,
measured against its own size. A message that carries no reading is stepped over rather than
abandoning the chart, and the note counts what it stepped over; past half of them it gives up,
since that is no longer a sensor with gaps in it.

**time** and **dist** read the same run in order or as a distribution. **csv** copies it out with
full timestamps. **Settings → Chart detail** picks how much of all this to draw: *plain* is the
line alone, *full* adds the marks and the note, *deep* draws both views at once.

## Keeping your settings

The container starts empty and forgets on `docker rm`. `MqttForge__SettingsPath` is what moves
the settings out of it, and it names a **file**, not a directory. The colour rules land beside
that file, so one mounted volume holds both:

```
docker run -d -p 5169:5169 \
  -e MqttForge__SettingsPath=/data/connection-settings.json \
  -v mqtt-forge-data:/data \
  --name mqtt-forge ghcr.io/ibrahimilkhan/mqtt-forge
```

Both ways of getting this wrong are quiet: mount the volume without the variable and it keeps
nothing, and point the variable at a directory and every save fails with only a line in
`docker logs`. Swapping the named volume for a host directory needs one more step on Linux,
where Docker creates it owned by root while the app runs as uid 1654 — `chown 1654:1654 ./data`
before starting, or it saves nothing.

The desktop app needs none of this. It keeps both files in the per-user data directory —
`~/Library/Application Support/MQTTForge` on macOS, `~/.config/MQTTForge` on Linux,
`%APPDATA%\MQTTForge` on Windows — because a mounted disk image is read-only.

> **The broker password is stored as typed**, in plain text in that settings file. Nothing in it
> is encrypted, so it deserves the care any file holding a credential does.

## Updating

`docker run` reuses the image already on the machine, so pulling changes nothing until the
container is replaced:

```
docker pull ghcr.io/ibrahimilkhan/mqtt-forge
docker rm -f mqtt-forge
```

Then start it again with the run command above. A named volume outlives `docker rm`, so settings
and colour rules come back with it; without one, the new container starts empty. To stay on a
build instead, every release tags its version alongside `latest` —
`ghcr.io/ibrahimilkhan/mqtt-forge:v0.3.0` holds still.

## Roadmap

Planned, in rough order:

- **Automation** — scripted sequences of publishes and expected replies, so a scenario can be
  replayed instead of clicked through.
- **Recording** — capture a session's traffic to a file and play it back.
- **Load testing** — many clients and sustained publish rates, to see how a broker holds up.
- **MQTT 3.1.1** — a broker that only speaks 3.1.1 currently refuses the connection.

## From source

Needs .NET 10 and Node 22+.

```
dotnet run --project src/MqttForge.Api    # http://localhost:5169
npm --prefix web run dev                  # http://localhost:5173
```

Open http://localhost:5173 — Vite proxies `/api` and `/hubs` through to the API. `dotnet publish
-c Release` builds the interface into the API and serves everything from one process on one port.
[CONTRIBUTING.md](CONTRIBUTING.md) has the rest: tests, packaging, and where each layer lives.

## Ideas are welcome

Anything missing, broken, or worth doing differently — [open an
issue](https://github.com/ibrahimilkhan/mqtt-forge/issues). A sentence is enough, and a gap you
hit is worth reporting even if you would not fix it yourself.
[CONTRIBUTING.md](CONTRIBUTING.md) covers sending a change.

## Licence

[AGPL-3.0](LICENSE).
