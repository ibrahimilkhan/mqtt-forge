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

    private ConnectionState _state = ConnectionState.Disconnected;

    // Separates a disconnect the user asked for from one caused by the network or the
    // broker; only the latter counts as Faulted.
    private bool _disconnectRequested;

    public MqttnetConnectionManager(MqttnetClientProvider provider, IConnectionStateNotifier notifier)
    {
        _client = provider.Client;
        _gate = provider.Gate;
        _notifier = notifier;

        _client.DisconnectedAsync += OnDisconnectedAsync;
    }

    public ConnectionState State => _state;

    // Per the single-active-connection rule, closes the existing connection first
    // if already connected, so the user can change settings and reconnect.
    public async Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            // Announced before the old link is closed so the disconnect event that follows
            // can see that a new attempt already owns the state.
            await SetStateAsync(ConnectionState.Connecting);

            if (_client.IsConnected)
            {
                _disconnectRequested = true;
                await _client.DisconnectAsync(cancellationToken: ct);
            }

            _disconnectRequested = false;

            try
            {
                await _client.ConnectAsync(BuildOptions(settings), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                await SetStateAsync(ConnectionState.Faulted);
                throw new BrokerUnreachableException(
                    $"Could not connect to broker ({settings.Host}:{settings.Port}): {ex.Message}", ex);
            }

            await SetStateAsync(ConnectionState.Connected);
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
            _disconnectRequested = true;
            await _client.DisconnectAsync(cancellationToken: ct);
            await SetStateAsync(ConnectionState.Disconnected);
        }
        finally
        {
            _gate.Release();
        }
    }

    private Task OnDisconnectedAsync(MqttClientDisconnectedEventArgs e)
    {
        var requested = _disconnectRequested;
        _disconnectRequested = false;

        // A reconnect closes the old link on purpose while a new attempt is already
        // under way; that attempt owns the state, so leave it alone.
        if (_state == ConnectionState.Connecting) return Task.CompletedTask;

        return SetStateAsync(requested ? ConnectionState.Disconnected : ConnectionState.Faulted);
    }

    // Records the new state and announces it; a repeat of the current state is not news.
    private Task SetStateAsync(ConnectionState state)
    {
        if (_state == state) return Task.CompletedTask;

        _state = state;
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
