using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;
using MQTTnet;

namespace MQFaker.Infrastructure.Mqtt;

public sealed class MqttnetConnectionManager : IMqttConnectionManager
{
    private readonly IMqttClient _client;

    public MqttnetConnectionManager(MqttnetClientProvider provider) => _client = provider.Client;

    public ConnectionState State => _client.IsConnected
        ? ConnectionState.Connected
        : ConnectionState.Disconnected;

    public async Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        var builder = new MqttClientOptionsBuilder()
            .WithTcpServer(settings.Host, settings.Port)
            .WithClientId(settings.ClientId);

        if (settings.Username is not null)
            builder = builder.WithCredentials(settings.Username, settings.Password);

        if (settings.UseTls)
            builder = builder.WithTlsOptions(o => o.UseTls());

        await _client.ConnectAsync(builder.Build(), ct);
    }

    public async Task DisconnectAsync(CancellationToken ct) =>
        await _client.DisconnectAsync(cancellationToken: ct);
}
