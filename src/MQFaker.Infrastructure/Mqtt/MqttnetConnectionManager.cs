using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;
using MQFaker.Domain.Exceptions;
using MQFaker.Domain.Models;
using MQTTnet;

namespace MQFaker.Infrastructure.Mqtt;

public sealed class MqttnetConnectionManager : IMqttConnectionManager
{
    private readonly IMqttClient _client;
    private readonly SemaphoreSlim _gate;

    public MqttnetConnectionManager(MqttnetClientProvider provider)
    {
        _client = provider.Client;
        _gate = provider.Gate;
    }

    public ConnectionState State => _client.IsConnected
        ? ConnectionState.Connected
        : ConnectionState.Disconnected;

    // Tek aktif bağlantı ilkesi gereği, zaten bağlıysa önce mevcut bağlantıyı kapatır;
    // böylece kullanıcı ayarları değiştirip tekrar bağlanabilir.
    public async Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            if (_client.IsConnected)
                await _client.DisconnectAsync(cancellationToken: ct);

            try
            {
                await _client.ConnectAsync(BuildOptions(settings), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                throw new BrokerUnreachableException(
                    $"Broker'a bağlanılamadı ({settings.Host}:{settings.Port}): {ex.Message}", ex);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task DisconnectAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await _client.DisconnectAsync(cancellationToken: ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static MqttClientOptions BuildOptions(BrokerConnectionSettings settings)
    {
        var builder = new MqttClientOptionsBuilder()
            .WithTcpServer(settings.Host, settings.Port)
            .WithClientId(settings.ClientId);

        if (!string.IsNullOrEmpty(settings.Username))
            builder = builder.WithCredentials(settings.Username, settings.Password);

        if (settings.UseTls)
            builder = builder.WithTlsOptions(o => o.UseTls());

        return builder.Build();
    }
}
