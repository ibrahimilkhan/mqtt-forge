# MQFaker

An MQTT test console: connect to a broker, watch topics as they arrive, and publish
messages by hand. A .NET API drives an MQTT client and pushes what it receives to a React
interface over SignalR.

MQFaker connects to a broker you already run — it is not a broker itself.

## Requirements

- .NET 10
- Node 22+ (only to build the interface)

## Development

The API and the interface run as two processes:

```
dotnet run --project src/MQFaker.Api      # http://localhost:5169
npm --prefix web run dev                  # http://localhost:5173
```

Open http://localhost:5173. Vite proxies `/api` and `/hubs` through to the API, so the
browser stays on one origin and CORS never enters the picture.

## Building

```
dotnet publish -c Release
```

A Release build compiles the interface into `src/MQFaker.Api/wwwroot`, so the published
application serves everything from a single process on a single port. `dotnet build -c Debug`
skips the npm step, which keeps backend iteration fast; pass `-p:SkipFrontend=true` to skip
it in Release too.

`src/MQFaker.Api/wwwroot` is generated output and is not tracked.

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
| `src/MQFaker.Domain` | Models and the abstractions the other layers implement |
| `src/MQFaker.Application` | Use cases, one service per capability |
| `src/MQFaker.Infrastructure` | MQTTnet client, local settings storage |
| `src/MQFaker.Api` | Controllers, SignalR hub, composition root |
| `web` | React + TypeScript interface |
| `docs/superpowers` | Design specs and implementation plans |

## Licence

AGPL-3.0.
