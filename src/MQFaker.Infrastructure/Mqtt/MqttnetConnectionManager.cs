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

    // The client is the only authority on whether a link exists. This field records which
    // flavour of "not connected" applies and is ignored while the client is up, so no
    // ordering of MQTTnet's background disconnect event can make State call a dead link
    // alive.
    private ConnectionState _offlineState = ConnectionState.Disconnected;

    // What listeners were last told, so the same state is not announced twice.
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

    // Per the single-active-connection rule, closes the existing connection first if
    // already connected, so the user can change settings and reconnect.
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

                // Announced once the old link is down; until then State still reports the
                // connection this attempt is replacing.
                await AnnounceAsync();

                await _client.ConnectAsync(BuildOptions(settings), ct);
            }
            catch (OperationCanceledException)
            {
                // The caller walked away and nothing was established.
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

            // From here on, being offline means the link died rather than was closed on
            // purpose — including a session the broker drops the instant it opens, which
            // State reports without this method having to observe it.
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
            // Recorded before the call: MQTTnet tears the socket down even when sending the
            // DISCONNECT packet fails, so this is the right flavour either way.
            _offlineState = ConnectionState.Disconnected;
            await _client.DisconnectAsync(cancellationToken: ct);
        }
        finally
        {
            _gate.Release();
            await AnnounceAsync();
        }
    }

    // MQTTnet raises this from a fire-and-forget task. It needs no judgement of its own:
    // State already answers what happened, because whoever closed the link recorded why.
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
