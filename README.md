# MQTTForge

[![Release](https://img.shields.io/github/v/release/ibrahimilkhan/mqtt-forge?color=1b3a7a&label=release)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest)
[![Image](https://img.shields.io/badge/ghcr.io-mqtt--forge-1b3a7a?logo=docker&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/pkgs/container/mqtt-forge)
[![Licence](https://img.shields.io/github/license/ibrahimilkhan/mqtt-forge?color=1b3a7a)](LICENSE)

An open-source MQTT test tool: connect, watch, chart, and publish. It runs as a desktop app or as one Docker
image — nothing to drive from a terminal.

The broker connection is held by the server rather than by the browser, so every device you point
at it — your desktop, or a phone from the QR panel — is working one connection, one set of
subscriptions and one set of colour rules.

MQTTForge connects to a broker you already run — it is not a broker itself.

![MQTTForge on Helsinki's tram feed: the topic tree in the middle, each vehicle showing what it
has sent, in the colours its rules give it; on the right the newest message, the odometer of the
runs behind it, and the publish form](.github/assets/console.png)

## What it does

- **Topic tree** — the broker's topology as it builds, each topic showing its own latest payload.
- **Wire log** — the newest message on whatever you pick, one branch or the whole broker,
  stamped with its time, QoS and size, with the history behind it a click at a time. When a
  selection is silent because a command failed rather than because the sensor is quiet, it says
  which one and why.
- **Readings, not just messages** — a topic sending numbers gets a chart of its run, in a
  region of its own, and under it what that run adds up to. What it says depends on what the run
  *is*: a quantity gets a mean, a spread, a trend and its outliers; a switch or a pulse train
  gets counted and timed instead, because the average of a door is a number the door has never
  been; a running total gets the rate it is climbing at. A branch of the tree draws one plot per
  topic. A JSON body's fields are each chartable by name.
- **A range you can read** — a sensor that reads 1, 2, 3 all day and once reads 4000 is drawn,
  on its extremes, as a flat line with one hair going to the top. Pick the middle of the run
  instead and the readings get the height, with the strays pinned to the edge and counted — never
  dropped.
- **Publish** — text, JSON or hex, with QoS and the retained flag; any logged message reloads
  into the form for a resend.
- **Filters** — connecting subscribes to `#` unless you untick the box, so the tree fills on its
  own; narrow it to one filter or a list when a busy broker makes that too much. A broker that
  refuses `#` outright — some public ones do — says so, and leaves a button that opens Filters.
- **Colour rules** — MQTT filters you pick colours for, so a branch stands out in a tree of
  hundreds.
- **Chart windows** — open a chart over the app, and pin it to keep it there: it holds the topic
  it was opened on while the rest of the app moves on. Several at once, so two runs can be read
  side by side.
- **QR panel** — opens the same app on a phone on your network.
- **Chart panel** — how much of the chart to draw, what range it opens on, what is drawn round
  it, a switch for every reading the note can make, and a line on every chip over the plot saying
  what it does. `spread`, `duty` and `csv` are three-letter labels; this is where they are
  spelled out.
- **Settings** — the fonts and their size, and the line that says what the console is carrying.

## What it connects to

Every MQTT there is, over every way in:

- **MQTT 5.0, 3.1.1 and 3.1** — and you are never asked which. The console offers 5.0, then
  3.1.1, then 3.1, and keeps the first one the broker takes; it steps down for the two refusals
  that mean "wrong version" and stops for everything else, so a wrong password is still reported
  once rather than three times. The connection panel says which one the broker agreed to.
- **`mqtt://`, `mqtts://`, `ws://`, `wss://`** — asked as the two questions they are. A dropdown
  at the head of the address picks `mqtt://` or `ws://`: a socket of its own, or a WebSocket for
  a broker behind a reverse proxy, which is also where the WebSocket path appears (empty means
  `/mqtt`, what nearly every broker publishes). Beside the port, one box for **Encrypted (TLS)**
  — the same question the `s` asks, in the word people have for it.
- **Three things tick that box for you.** A port that says so, since 8883 and 8084 are the ports
  brokers listen for encrypted connections on; an address you paste, since `mqtts://` says it
  outright; and naming a certificate, which is not a preference about encryption but encryption
  itself. Most encrypted brokers need no certificate at all — a publicly trusted one is verified
  the way a browser verifies it, with nothing configured.
- **A connection that fails on the wrong one says so with a button.** A broker that refuses
  encryption, or a plain connection that gets nothing back from the port brokers listen for
  encrypted ones on, both offer the scheme they point at and retry on it.
- **The Broker tab is the readout** — green while a link is up, and breathing, so a glance at
  the rail answers "is this thing connected" without opening anything. Red with a warning mark
  when something is wrong, including the console losing its own link to the server. The address
  it is pointed at is in its tooltip.
- **Brokers you keep** — press **Save**, give it a name, and it becomes a chip at
  the foot of the panel that fills the form back in. Saved to `saved-brokers.json` beside the
  rest, so one mounted volume keeps them. Passwords are written but never sent back to the
  browser, so you enter one again to connect.
- **Cloud brokers** — what they need beyond a username and password is under **Encryption**: a
  **client certificate** for the brokers that authenticate that way, an **extra CA** for the ones
  behind a private one, a **server name** for anything routed by SNI, and an **ALPN protocol**,
  which is what gets MQTT through a firewall that allows only 443. Most encrypted brokers need
  none of it — a publicly trusted certificate is verified the way a browser verifies one — and
  the section asks only as far as your answers go: a private key and a certificate password
  appear once there is a certificate to belong to, and not at all beside a `.pfx`, which carries
  its own key.
- **A broker of your own** — including one with a certificate it signed itself. Name its CA and
  the chain is still verified, just to a root you supplied; or accept any certificate, which is
  a box you have to tick.
- **The certificates, pointed at rather than typed** — in the desktop app each of those three
  paths has a **Choose…** button beside it that opens the system's own file dialog. The dialog
  belongs to the machine MQTTForge is running on, which is exactly the point: that is where the
  files are read. A browser pointed at the same server gets no button — a file input hands over
  the bytes with the path hidden, and the bytes are no use to a process that has to open the
  file itself.

When a connection does not come up, the panel says which of about thirty things went wrong and
what to do about it — the path rather than the port when a WebSocket handshake was refused, the
certificate at your end rather than the broker's when it wanted one and got none.

## Download

[![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-macos-arm64.dmg)
[![macOS Intel](https://img.shields.io/badge/macOS-Intel-555555?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-macos-x64.dmg)
[![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-windows-x64.zip)
[![Linux x64](https://img.shields.io/badge/Linux-x64-1b3a7a?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/ibrahimilkhan/mqtt-forge/releases/latest/download/MQTTForge-linux-x64.tar.gz)

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

It answers to addresses, not to names: `localhost`, any IP, and Bonjour names ending `.local`. A
request naming anything else is refused before it is served. That is what keeps the loopback
recipe above worth doing — a page from `http://evil.example:5169` whose own name has since been
re-pointed at `127.0.0.1` is same-origin as far as the browser is concerned, so it would otherwise
reach a server bound to loopback alone. If you do want a name of your own — behind a reverse
proxy, say — set `AllowedHosts` to it and ASP.NET's own host filtering takes over:

```
docker run -d -p 5169:5169 -e AllowedHosts=mqtt.example.com ghcr.io/ibrahimilkhan/mqtt-forge
```

## Running it with Docker

**1. Start it.** One image covers amd64 and arm64, so this is the same line on an Intel box and
on Apple Silicon:

```
docker run -d -p 5169:5169 --name mqtt-forge ghcr.io/ibrahimilkhan/mqtt-forge
```

**2. Open http://localhost:5169.** It loads with the Broker panel already open.

**3. Point it at your broker** — paste the address and press **Enter**. The one off your broker's
own documentation goes in whole: `mqtts://host:8883` into **Broker address**, and the way in, the
port and any WebSocket path sort themselves out. A hostname on its own works too; the dropdown
beside it and the box below say how it will connect. Which host depends on where the broker runs:

| Your broker runs | Host to enter |
|---|---|
| On another machine | Its hostname or IP |
| In another container | That container's name, with both on one `--network` |
| On this machine, outside Docker | `host.docker.internal` — **not** `localhost` |

`localhost` inside a container means the container itself, which is why the last row needs the
special name. On Docker Desktop it works as-is; on Linux add
`--add-host=host.docker.internal:host-gateway` to the run command above.

The same reasoning applies to certificates. MQTTForge holds the broker connection server-side,
so a client certificate or a CA is read where the server runs — inside the container. Mount the
directory and give the panel the path it has in there:

```
docker run -d -p 5169:5169 -v ~/certs:/certs:ro ghcr.io/ibrahimilkhan/mqtt-forge
```

Then **Client certificate** is `/certs/device.pem.crt`, not the path on your own disk.

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

**5. Read one branch.** Click a node in the tree and the right column narrows to that subtree.
It has three fixed places, top to bottom: the newest message with its history a click away, the
chart of the run behind it, and the publish form. If the topic sends numbers, the chart draws
the run and the note under it says what that adds up to — every reading in a slot of its own, so
the numbers change without shifting each other about. A branch covering several topics draws one
plot each, and clicking a row narrows the pane to that topic. **hold** freezes the column while
you read it, without stopping the log behind it; **csv** takes the readings away with you. Drag
either seam to give a region more room, or fold a region to its own strip and give the whole
column to one of the other two.

**6. Send one.** The publish form takes a topic, a payload as text, JSON or hex, a QoS and the
retained flag. Clicking any logged message loads it back into the form to send again.

**7. Stop and start.** `docker stop mqtt-forge` and `docker start mqtt-forge` keep everything;
`docker rm` throws the settings away, which the next section is about.

## Colouring topics

The **Colours** panel takes a list of MQTT filters and a colour for each — `sensors/+/temp`,
`alerts/#`, whatever you watch for. Every topic a rule covers is then drawn in that colour, in
the tree and in the log, with the row's left edge carrying it too.

![The Colours panel holding two rules beside the tree they paint: /hfp/v2/# colours the whole
feed red, and the longer filter under it picks the trams out of it in
purple](.github/assets/colours.png)

When two rules cover one topic the more specific filter wins: read left to right, a named
segment beats `+`, and `+` beats `#`. So `sensors/#` can colour a whole subtree while
`sensors/+/temp` picks the temperatures out of it. Editing a rule recolours what is already on
screen, history included, and the rules live with the API rather than in the browser, so a phone
opened from the QR panel sees the same colours.

## Reading a sensor

A topic whose messages are numbers is a measurement, and a tool that only shows you the
latest one leaves the arithmetic to your eye — which is the arithmetic an eye is worst at. Pick
such a topic and the pane draws its run, and writes what the run adds up to underneath:

- **How many, and where the middle is** — count, mean, median, standard deviation and range,
  with the quartiles a switch away. On a run that is not a quantity these are replaced rather
  than printed: see *what kind of thing it is* below.
- **Where the readings actually are** — every arrival gets a dot on the line, so a run sampled ten
  times cannot be mistaken for one sampled a thousand; between two dots the line is an
  interpolation nobody measured. The dot is sized against the plot it is drawn in — a speck in a
  folded-down region would be a blot in a chart thrown open over the window — and dropped
  altogether once the readings are closer together than a dot is wide.
- **What does not belong** — readings outside Tukey's fences wear a ring instead of a dot, in the
  fault colour, and are counted in the note.
- **Where it is going** — a least-squares trend, but only when the drift is larger than the
  readings' own spread; anything smaller is a line through a cloud.
- **What one reading is** — click anywhere on the plot, or press Enter while walking it with
  the arrow keys, and the nearest reading opens: its value, when it arrived, which of the run it
  is, what it changed by since the one before, and how far it sits from the mean in deviations.
  A reading the chart has marked says so in words — outside the fences, past the plot's range.
  Escape closes it.
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

- **What kind of thing it is** — a mean is a fact about a temperature and a fiction about a door
  sensor, so the run is classified before anything is said about it. A **switch** — a handful of
  levels the run really moves between — is drawn as the steps it actually is, and read as events,
  duty cycle, how long each excursion lasts and how often one comes, with the line they were
  counted against drawn on the plot. A **pulse train** — a rest with events on it — is read the
  same way.

One message can carry a whole environment, so a JSON body's numeric fields are offered by name —
`temp`, `env.hum`, `cells.0` — and the pane opens on whichever of them is doing the most,
measured against its own size. A message that carries no reading is stepped over rather than
abandoning the chart, and the note counts what it stepped over — in the fault colour when more of
the run was stepped over than was drawn.

### Two runs at once

The corner control over the chart opens it as a window across the app, and the pin in that
window's bar keeps it there: a pinned window holds the topic it was opened on while the app below
carries on being used for something else. Open a second on another topic and the two stand side
by side. Unpin one to move or size it, drag it near an edge and it takes the edge, and the × in
its bar closes it.

![Two chart windows standing over the app, each with the tram it was opened on in its bar and
its own readings underneath, while the console below carries on](.github/assets/windows.png)

A selection covering several topics — which is what clicking a branch of the tree gives you —
draws one small plot per topic, each on its own scale, since °C and % share no axis but do share
a moment. Clicking a row narrows the pane to that topic, where the note and the field chips are.
And when there is nothing to draw at all the pane says which of the reasons it is — the run is
one message old, the bodies are not numbers, the field you picked is not in them — with the
topic's own newest message underneath as evidence.

### The range

Four chips over the plot decide how much of its height goes on the run's range:

- **auto** lets the readings decide. A quantity takes whatever **Chart → Range** says; a switch,
  a pulse always takes its extremes, because clipping a pulse shaves off the signal.
- **ends** spends the height on the whole run, from its lowest reading to its highest.
- **mid** spends it on where the readings mostly are — Tukey's fences, the same line the note
  draws between spread and an outlier. Readings past the edge are drawn *on* it, marked, and
  counted both on the axis and in the note's **off scale** slot. Nothing is ever quietly dropped.
- **log** gives each decade the same height. Positive runs only; a run that reaches zero falls
  back to its extremes rather than pretending.

The plot carries its own edge, so a line lying along the top can be told from one near it.
**time** and **dist** read the same run in order or as a distribution. **csv** copies the readings
on the chart to the clipboard — a header, then one row per reading with its time in full — so they
go straight into a spreadsheet or a notebook. Every chip over the plot is three or four characters,
because the row shares a pane that can be two hundred pixels wide; the **Chart** panel prints what
each of them does. The control in the region's top-right corner lifts the chart out of its column —
the plot lives in a third of a column that is itself a third of the window, which is the right
size for glancing at a run and the wrong size for reading one. Open, it takes three fifths of the
window and leaves the rest readable around it, and still live: click a topic in the tree and the
chart redraws for it without closing. The same control, or **Escape**, puts it back — or pin it,
and it stays as a window of its own.

### The chart panel

Everything else about the chart is here. Every reading the note can make, grouped by the kind of run it applies to, each with a
switch and a line saying what it is:

| | |
|---|---|
| `n` | how many readings are on the chart |
| `mean` | the average — one wild reading drags it |
| `median` | the middle reading; a wild reading barely moves it |
| `spread` | how far a reading usually sits from the mean (σ) |
| `range` | the lowest reading and the highest |
| `quartiles` `fences` | the middle half, and the line past which a reading is an outlier |
| `shape` `trend` `step` `cycle` `outliers` | what the run is doing, and what does not belong to it |
| `levels` `events` `duty` `width` `period` | a switch or a pulse, counted and timed |
| `every` `off scale` `window` `skipped` `silence` | true of any run: its rhythm, what the plot could not hold, and what was left out |

A reading switched off leaves the note; switch them all off and the note goes with them. Hovering
a cell in the note gives the same sentence the panel prints, so the two cannot drift apart.

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

## How it is built

- **API** (.NET 10) holds the one broker connection and pushes to every browser over SignalR.
- **Console** (React 19, TypeScript, Vite) — no MQTT in the browser; one bundle, served by the API.
- **Desktop** (Photino) wraps the same server in a window.

## What it costs

Measured on Helsinki's tram feed, in the console's own health line:

| Holding | Taking it in | Drawing |
| --- | --- | --- |
| 128k messages · 6.7k topics · 36.8 MB | 1 ms per second | 47 fps |

Arrivals are handed to the interface a frame at a time, 2,000 at most — about 120k a second — so
a burst fills the log rather than locking the window. The log keeps half a million messages and
drops the oldest.

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
