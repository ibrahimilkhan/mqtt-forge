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
    private readonly IConnectionStateNotifier _notifier;

    // Reason we're offline; ignored while client reports connected, avoiding disconnect-event races
    private ConnectionState _offlineState = ConnectionState.Disconnected;

    // Last state announced, to avoid duplicate notifications
    private int _announced = (int)ConnectionState.Disconnected;

    public MqttnetConnectionManager(MqttnetClientProvider provider, IConnectionStateNotifier notifier)
    {
        _client = provider.Client;
        _gate = provider.Gate;
        _notifier = notifier;

        _client.DisconnectedAsync += OnDisconnectedAsync;
    }

    public ConnectionState State =>
        _client.IsConnected ? ConnectionState.Connected : _offlineState;

    // Single-active-connection rule: disconnect any existing link before reconnecting
    public async Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            _offlineState = ConnectionState.Connecting;

            try
            {
                if (_client.IsConnected)
                    await _client.DisconnectAsync(cancellationToken: ct);

                // Announce only after the old link is down
                await AnnounceAsync();

                await _client.ConnectAsync(BuildOptions(settings), ct);
            }
            catch (OperationCanceledException)
            {
                // Caller cancelled, not a failure
                _offlineState = ConnectionState.Disconnected;
                await AnnounceAsync();
                throw;
            }
            catch (Exception ex)
            {
                _offlineState = ConnectionState.Faulted;
                await AnnounceAsync();
                throw new BrokerUnreachableException(
                    $"Could not connect to broker ({settings.Host}:{settings.Port}): {ex.Message}", ex);
            }

            // Post-connect, offline now means the link died, not a deliberate close
            // (also covers the broker dropping the session the instant it opens)
            _offlineState = ConnectionState.Faulted;
            await AnnounceAsync();
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
            // Set before the call: socket closes even if sending DISCONNECT fails
            _offlineState = ConnectionState.Disconnected;
            await _client.DisconnectAsync(cancellationToken: ct);
        }
        finally
        {
            _gate.Release();
            await AnnounceAsync();
        }
    }

    // Fire-and-forget MQTTnet event; State already reflects why, no judgement needed here
    private Task OnDisconnectedAsync(MqttClientDisconnectedEventArgs e) => AnnounceAsync();

    private Task AnnounceAsync()
    {
        var state = State;
        if (Interlocked.Exchange(ref _announced, (int)state) == (int)state) return Task.CompletedTask;

        return _notifier.NotifyStateChangedAsync(state);
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
