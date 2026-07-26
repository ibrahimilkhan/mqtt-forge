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

            try
            {
                if (_client.IsConnected)
                    await _client.DisconnectAsync(cancellationToken: ct);

                await _client.ConnectAsync(BuildOptions(settings), ct);
            }
            catch (OperationCanceledException)
            {
                // The caller walked away and nothing was established, so the honest state is
                // Disconnected; leaving it at Connecting strands the readout for good.
                await SetStateAsync(ConnectionState.Disconnected);
                throw;
            }
            catch (Exception ex)
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
            await _client.DisconnectAsync(cancellationToken: ct);
            await SetStateAsync(ConnectionState.Disconnected);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task OnDisconnectedAsync(MqttClientDisconnectedEventArgs e)
    {
        // MQTTnet raises this from a fire-and-forget task, so it can land in the middle of a
        // connect or disconnect this class is running. Those hold the gate for their whole
        // duration and record the outcome themselves, so a drop that cannot take the gate is
        // already someone else's business.
        if (!await _gate.WaitAsync(0)) return;

        try
        {
            // A live client means the event describes a link that is already history.
            if (_client.IsConnected) return;

            // Anything this class closed on purpose has already reported its own state.
            if (_state != ConnectionState.Connected) return;

            await SetStateAsync(ConnectionState.Faulted);
        }
        finally
        {
            _gate.Release();
        }
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
