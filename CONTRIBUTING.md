# Contributing

Suggestions are as welcome as code. If something is missing, broken, or would be better done
another way, [open an issue](https://github.com/ibrahimilkhan/mqtt-forge/issues) — a sentence is
enough to start with.

## Sending a change

You need .NET 10 and Node 22+.

```
dotnet run --project src/MqttForge.Api    # http://localhost:5169
npm --prefix web run dev                  # http://localhost:5173
```

Before opening a pull request:

```
dotnet test                    # the MQTT integration tests need Docker running
npm --prefix web test
```

Keep the change to one thing, and write the commit message about why rather than what — the
diff already says what. A behaviour change wants a test with it.

## Where things live

`src/MqttForge.Domain` holds the models, `src/MqttForge.Application` the use cases,
`src/MqttForge.Infrastructure` the MQTT client and storage, `src/MqttForge.Api` the controllers
and the SignalR hub, and `web` the React interface.

## Licence

Contributions are made under [AGPL-3.0](LICENSE), the licence the project carries.
