using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MqttForge.UnitTests.Api;
using MQTTnet;
using MQTTnet.Exceptions;
using MQTTnet.Packets;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

/// <summary>
/// A link that drops while the broker is still sending to it, told apart from one that died.
///
/// Measured against mqtt.hsl.fi with a socket window too narrow for the feed: every drop came with
/// no DISCONNECT, as a ping that went unanswered or as a socket the broker closed, and every one
/// with the last message milliseconds old. A link that is really gone has been silent for the half
/// keep-alive the ping is given before it is called dead.
/// </summary>
public class MqttnetConnectionManagerFellBehindTests
{
    private static readonly DateTimeOffset Noon = new(2026, 11, 17, 12, 0, 0, TimeSpan.Zero);

    private readonly IMqttClient _client = Substitute.For<IMqttClient>();
    private readonly IConnectionStateNotifier _notifier = Substitute.For<IConnectionStateNotifier>();
    private readonly FakeTimeProvider _time = new(Noon);
    private readonly RecordingLogger<MqttnetConnectionManager> _log = new();
    private readonly BrokerConnectionSettings _settings = new("mqtt.hsl.fi", 8883, "console", null, null, true);

    private async Task<MqttnetConnectionManager> ConnectedSut()
    {
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(true);
                return Task.FromResult(new MqttClientConnectResult { ResultCode = MqttClientConnectResultCode.Success });
            });

        var sut = new MqttnetConnectionManager(
            new MqttnetClientProvider(_client), _notifier, timeProvider: _time, logger: _log);
        await sut.ConnectAsync(_settings, CancellationToken.None);
        return sut;
    }

    // `perSecond` messages of a kilobyte each, spread evenly over `seconds`.
    private void TheBrokerSends(int perSecond, int seconds)
    {
        var message = new MqttApplicationMessageBuilder()
            .WithTopic("/hfp/v2/journey/ongoing/vp/tram")
            .WithPayload(new byte[1024 - 30])
            .Build();
        var step = TimeSpan.FromSeconds(1.0 / perSecond);

        for (var i = 0; i < perSecond * seconds; i++)
        {
            _time.Advance(step);
            _client.ApplicationMessageReceivedAsync += Raise.Event<Func<MqttApplicationMessageReceivedEventArgs, Task>>(
                new MqttApplicationMessageReceivedEventArgs(
                    "console", message, new MqttPublishPacket(), (_, _) => Task.CompletedTask));
        }
    }

    private void TheLinkDrops(MqttClientDisconnectReason reason, Exception? exception = null)
    {
        _client.IsConnected.Returns(false);
        _client.DisconnectedAsync += Raise.Event<Func<MqttClientDisconnectedEventArgs, Task>>(
            new MqttClientDisconnectedEventArgs(
                clientWasConnected: true, connectResult: null, reason, reasonString: null,
                userProperties: null, exception));
    }

    private static readonly Exception PingUnanswered = new MqttCommunicationTimedOutException();

    [Fact]
    public async Task A_ping_unanswered_while_messages_pour_in_is_falling_behind()
    {
        var sut = await ConnectedSut();
        TheBrokerSends(perSecond: 200, seconds: 15);

        TheLinkDrops(MqttClientDisconnectReason.NormalDisconnection, PingUnanswered);

        Assert.Equal(BrokerFailureReason.FellBehind, sut.Failure!.Reason);
    }

    // The other shape it was measured in: no exception, no DISCONNECT, a socket the broker closed.
    [Fact]
    public async Task A_socket_the_broker_closes_while_messages_pour_in_is_falling_behind()
    {
        var sut = await ConnectedSut();
        TheBrokerSends(perSecond: 200, seconds: 15);

        TheLinkDrops(MqttClientDisconnectReason.NormalDisconnection);

        Assert.Equal(BrokerFailureReason.FellBehind, sut.Failure!.Reason);
    }

    [Fact]
    public async Task The_failure_carries_how_fast_the_broker_was_sending()
    {
        var sut = await ConnectedSut();
        TheBrokerSends(perSecond: 200, seconds: 15);

        TheLinkDrops(MqttClientDisconnectReason.NormalDisconnection, PingUnanswered);

        var traffic = sut.Failure!.Traffic!;
        Assert.Equal(200, traffic.MessagesPerSecond, precision: 0);
        Assert.Equal(200, traffic.KilobytesPerSecond, precision: 0);
    }

    [Fact]
    public async Task A_ping_unanswered_on_a_quiet_link_is_still_a_timeout()
    {
        var sut = await ConnectedSut();
        TheBrokerSends(perSecond: 200, seconds: 5);
        _time.Advance(TimeSpan.FromSeconds(30));

        TheLinkDrops(MqttClientDisconnectReason.NormalDisconnection, PingUnanswered);

        Assert.Equal(BrokerFailureReason.Timeout, sut.Failure!.Reason);
        Assert.Null(sut.Failure.Traffic);
    }

    // A sensor every few seconds is still arriving when a link goes, and is no backlog.
    [Fact]
    public async Task A_trickle_up_to_the_end_is_not_falling_behind()
    {
        var sut = await ConnectedSut();
        TheBrokerSends(perSecond: 2, seconds: 15);

        TheLinkDrops(MqttClientDisconnectReason.NormalDisconnection);

        Assert.Equal(BrokerFailureReason.BrokerClosed, sut.Failure!.Reason);
    }

    // The broker said why, so nothing is inferred: being taken over is not reading slowly.
    [Fact]
    public async Task A_broker_that_names_its_reason_is_believed()
    {
        var sut = await ConnectedSut();
        TheBrokerSends(perSecond: 200, seconds: 15);

        TheLinkDrops(MqttClientDisconnectReason.SessionTakenOver);

        Assert.Equal(BrokerFailureReason.SessionTakenOver, sut.Failure!.Reason);
    }

    [Fact]
    public async Task A_reconnect_does_not_inherit_the_last_links_traffic()
    {
        var sut = await ConnectedSut();
        TheBrokerSends(perSecond: 200, seconds: 15);
        TheLinkDrops(MqttClientDisconnectReason.NormalDisconnection, PingUnanswered);

        await sut.ConnectAsync(_settings, CancellationToken.None);
        _time.Advance(TimeSpan.FromSeconds(1));
        TheLinkDrops(MqttClientDisconnectReason.NormalDisconnection, PingUnanswered);

        Assert.Equal(BrokerFailureReason.Timeout, sut.Failure!.Reason);
    }

    [Fact]
    public async Task The_server_log_says_the_link_fell_behind_and_how_fast_it_was_fed()
    {
        await ConnectedSut();
        TheBrokerSends(perSecond: 200, seconds: 15);

        TheLinkDrops(MqttClientDisconnectReason.NormalDisconnection, PingUnanswered);

        var line = Assert.Single(_log.Entries, e => e.Level == LogLevel.Warning);
        Assert.Contains("mqtts://mqtt.hsl.fi:8883", line.Message);
        Assert.Contains("200 msg/s", line.Message);
        Assert.Contains("reading slower than the broker sends", line.Message);
    }

    // Every drop gets its line, not only the ones this class has a theory about: the server log
    // used to say nothing at all between a link going and the redial that followed.
    [Fact]
    public async Task The_server_log_names_any_other_drop_too()
    {
        await ConnectedSut();
        _time.Advance(TimeSpan.FromSeconds(30));

        TheLinkDrops(MqttClientDisconnectReason.NormalDisconnection, PingUnanswered);

        var line = Assert.Single(_log.Entries, e => e.Level == LogLevel.Warning);
        Assert.Contains("mqtts://mqtt.hsl.fi:8883", line.Message);
        Assert.Contains("Timeout", line.Message);
        Assert.Contains("no message", line.Message);
    }

    [Fact]
    public async Task A_disconnect_somebody_asked_for_is_not_logged_as_a_drop()
    {
        var sut = await ConnectedSut();
        TheBrokerSends(perSecond: 200, seconds: 15);

        await sut.DisconnectAsync(CancellationToken.None);
        TheLinkDrops(MqttClientDisconnectReason.NormalDisconnection);

        Assert.DoesNotContain(_log.Entries, e => e.Level == LogLevel.Warning);
    }
}
