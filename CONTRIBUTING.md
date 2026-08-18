# Contributing

Suggestions are as welcome as code. If something is missing, broken, or would be better done
another way, [open an issue](https://github.com/ibrahimilkhan/mqtt-forge/issues) — a sentence is
enough to start with.

## Running it

You need .NET 10 and Node 22+. The API and the interface run as two processes:

```
dotnet run --project src/MqttForge.Api    # http://localhost:5169
npm --prefix web run dev                  # http://localhost:5173
```

Open http://localhost:5173. Vite proxies `/api` and `/hubs` through to the API, so the browser
stays on one origin and CORS never enters the picture.

## Tests

```
dotnet test                    # unit and integration
npm --prefix web test          # interface
```

The integration tests that talk to a broker start a Mosquitto container, so they need Docker
running — that is several of the API tests, not only the ones under `Mqtt/`, and they fail rather
than skip without it. `dotnet test tests/MqttForge.UnitTests` is the part that runs without
Docker. CI runs both suites on every push and pull request.

## Looking at the interface

`web/src/gallery.render.test.tsx` is a renderer rather than a test. It builds the states a
browser cannot easily be driven to — a pulse train, a counter that wraps, a branch of six topics,
a payload that is not a number, the whole console with traffic in it — renders them through the
real components, and writes them as static pages into `src/MqttForge.Api/wwwroot`:

```
npm --prefix web run build      # empties wwwroot, so this comes first
npm --prefix web test           # writes gallery.html, gallery-1..3.html and console.html
```

Then `dotnet run --project src/MqttForge.Api` and open `/gallery.html` for the marks, `/console.html`
for the console. The CSS modules are compiled in the test environment, so what it writes is what
the tool draws. It skips itself when `wwwroot` is not there, which is every checkout that has not
been built yet.

`console.html` is also where the README's screenshots come from — it needs no broker.

## Building

`dotnet publish -c Release` compiles the interface into `src/MqttForge.Api/wwwroot` — generated
output, not tracked — so the published application serves everything from one process on one
port. The npm step runs in every configuration, so a Debug run never serves yesterday's bundle;
it is skipped while `web/` is unchanged, which costs nothing after the first build.
`-p:SkipFrontend=true` opts out of it entirely.

`./scripts/package-macos.sh` produces `dist/MQTTForge-macos-arm64.dmg`; pass `osx-x64` for the
Intel slice. Windows and Linux are published by the release workflow rather than by a script
here, though `dotnet publish -r win-x64 --self-contained` produces a complete tree from any
platform. `docker build -t mqtt-forge .` builds the container image from a checkout.

Releases are cut by pushing a `v*` tag. The workflow builds every platform and takes the release
notes from the tag's own message, so tag with `git tag -a` and say what changed.

## Where things live

| Path | What lives there |
|---|---|
| `src/MqttForge.Domain` | Models and the abstractions the other layers implement |
| `src/MqttForge.Application` | Use cases, one service per capability |
| `src/MqttForge.Infrastructure` | MQTTnet client, local settings storage |
| `src/MqttForge.Api` | Controllers, SignalR hub, composition root |
| `web` | React + TypeScript interface |

## Sending a change

Keep it to one thing, and write the commit message about why rather than what — the diff already
says what. A behaviour change wants a test with it, and both suites should pass before you open
the pull request.

Contributions are made under [AGPL-3.0](LICENSE), the licence the project carries.
