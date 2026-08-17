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

The MQTT integration tests start a Mosquitto container, so they need Docker running. The rest of
the suite does not.

## Building

`dotnet publish -c Release` compiles the interface into `src/MqttForge.Api/wwwroot` — generated
output, not tracked — so the published application serves everything from one process on one
port. `dotnet build -c Debug` skips the npm step to keep backend iteration fast, and
`-p:SkipFrontend=true` skips it in Release too.

`./scripts/package-macos.sh` produces `dist/MQTTForge-macos-arm64.dmg`; pass `osx-x64` for the
Intel slice. Windows and Linux packaging is not scripted yet — both need to run on their own
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
