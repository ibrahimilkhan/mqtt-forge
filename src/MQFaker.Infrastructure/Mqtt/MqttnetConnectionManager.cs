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

    // Why that offline state is a fault, when we know; same races, so gated the same way
    private BrokerFailureReason? _failureReason;

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

    public BrokerFailureReason? FailureReason => _client.IsConnected ? null : _failureReason;

    // Single-active-connection rule: disconnect any existing link before reconnecting
    public async Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            _offlineState = ConnectionState.Connecting;
            _failureReason = null;
            MqttClientConnectResult result;

            try
            {
                if (_client.IsConnected)
                    await _client.DisconnectAsync(cancellationToken: ct);

                // Announce only after the old link is down
                await AnnounceAsync();

                result = await _client.ConnectAsync(BuildOptions(settings), ct);
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
                _failureReason = BrokerFailureClassifier.Classify(ex, settings.UseTls);
                await AnnounceAsync();
                throw new BrokerUnreachableException(
                    _failureReason.Value,
                    $"Could not connect to broker ({settings.Host}:{settings.Port}): {ex.Message}", ex);
            }

            // A refusing CONNACK comes back as a result, not an exception; unread, it would
            // tell the caller a connection it never got was made.
            var refused = result.ResultCode != MqttClientConnectResultCode.Success;

            // Post-connect, offline now means the link died, not a deliberate close
            // (also covers the broker dropping the session the instant it opens)
            _offlineState = ConnectionState.Faulted;
            _failureReason = refused ? BrokerFailureClassifier.Classify(result.ResultCode) : null;
            await AnnounceAsync();

            if (refused)
                throw new BrokerUnreachableException(
                    _failureReason!.Value,
                    $"The broker at {settings.Host}:{settings.Port} refused the connection ({result.ResultCode}).");
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
            _failureReason = null;
            await _client.DisconnectAsync(cancellationToken: ct);
        }
        finally
        {
            _gate.Release();
            await AnnounceAsync();
        }
    }

    // Fire-and-forget MQTTnet event; State already reflects whether this was a fault
    private Task OnDisconnectedAsync(MqttClientDisconnectedEventArgs e)
    {
        // Only a fault needs explaining — a close we asked for already has its reason
        if (_offlineState == ConnectionState.Faulted)
            _failureReason = BrokerFailureClassifier.Classify(e);

        return AnnounceAsync();
    }

    private Task AnnounceAsync()
    {
        var state = State;
        if (Interlocked.Exchange(ref _announced, (int)state) == (int)state) return Task.CompletedTask;

        return _notifier.NotifyStateChangedAsync(state, FailureReason);
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
