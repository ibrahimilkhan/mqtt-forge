using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Exceptions;
using MQFaker.Domain.Models;
using MQFaker.Infrastructure.Mqtt;
using MQTTnet;
using NSubstitute;
using Xunit;

namespace MQFaker.UnitTests.Infrastructure;

// What the manager remembers about the link that is UP, as opposed to why one is down.
public class MqttnetConnectionManagerLinkTests
{
    private static readonly DateTimeOffset Noon = new(2026, 8, 8, 12, 0, 0, TimeSpan.Zero);

    private readonly IMqttClient _client = Substitute.For<IMqttClient>();
    private readonly IConnectionStateNotifier _notifier = Substitute.For<IConnectionStateNotifier>();
    private readonly BrokerConnectionSettings _settings = new("localhost", 1883, "id", null, null, false);

    private MqttnetConnectionManager CreateSut() =>
        new(new MqttnetClientProvider(_client), _notifier, timeProvider: new FixedTime(Noon));

    [Fact]
    public void Link_is_empty_before_anything_connects()
    {
        Assert.Null(CreateSut().Link);
    }

    [Fact]
    public async Task ConnectAsync_records_the_link_it_established()
    {
        GivenConnectSucceeds();
        var sut = CreateSut();
        var settings = new BrokerConnectionSettings(
            "broker.example", 8883, "console", "alice", "hunter2", UseTls: true);

        await sut.ConnectAsync(settings, CancellationToken.None);

        Assert.Equal(
            new BrokerLink(
                "broker.example", 8883, "console", "alice", UseTls: true,
                ConnectedAt: Noon, SessionPresent: false,
                AssignedClientId: null, ServerKeepAlive: null),
            sut.Link);
    }

    [Fact]
    public async Task Link_carries_a_resumed_session()
    {
        GivenConnectSucceeds(sessionPresent: true);
        var sut = CreateSut();

        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.True(sut.Link!.SessionPresent);
    }

    // MQTT 5 lets the broker name the client itself. Only worth reporting when it picked
    // something other than what we asked for — an echo of our own id says nothing.
    [Fact]
    public async Task Link_reports_a_client_id_the_broker_chose_for_us()
    {
        GivenConnectSucceeds(assignedClientId: "auto-4417");
        var sut = CreateSut();

        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.Equal("auto-4417", sut.Link!.AssignedClientId);
    }

    [Fact]
    public async Task Link_leaves_the_assigned_id_empty_when_the_broker_echoes_ours()
    {
        GivenConnectSucceeds(assignedClientId: "id");
        var sut = CreateSut();

        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.Null(sut.Link!.AssignedClientId);
    }

    [Fact]
    public async Task Link_carries_the_keep_alive_the_broker_imposed()
    {
        GivenConnectSucceeds(serverKeepAlive: 30);
        var sut = CreateSut();

        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.Equal((ushort)30, sut.Link!.ServerKeepAlive);
    }

    // MQTTnet reports "the broker did not impose one" as zero, which is not a keep-alive.
    [Fact]
    public async Task Link_leaves_the_keep_alive_empty_when_the_broker_imposes_none()
    {
        GivenConnectSucceeds(serverKeepAlive: 0);
        var sut = CreateSut();

        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.Null(sut.Link!.ServerKeepAlive);
    }

    [Fact]
    public async Task Link_is_empty_when_the_broker_refuses_the_connack()
    {
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(
                new MqttClientConnectResult { ResultCode = MqttClientConnectResultCode.NotAuthorized }));
        var sut = CreateSut();

        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        Assert.Null(sut.Link);
    }

    [Fact]
    public async Task Link_is_empty_once_the_broker_drops_us()
    {
        GivenConnectSucceeds();
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        _client.IsConnected.Returns(false);

        Assert.Null(sut.Link);
    }

    [Fact]
    public async Task Link_is_empty_after_a_deliberate_disconnect()
    {
        GivenConnectSucceeds();
        _client.DisconnectAsync(Arg.Any<MqttClientDisconnectOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(false);
                return Task.CompletedTask;
            });
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        await sut.DisconnectAsync(CancellationToken.None);

        Assert.Null(sut.Link);
    }

    // The real client flips IsConnected as part of connecting; a substitute has to be told to.
    private void GivenConnectSucceeds(
        bool sessionPresent = false, string? assignedClientId = null, ushort serverKeepAlive = 0) =>
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(true);
                return Task.FromResult(new MqttClientConnectResult
                {
                    ResultCode = MqttClientConnectResultCode.Success,
                    IsSessionPresent = sessionPresent,
                    AssignedClientIdentifier = assignedClientId,
                    ServerKeepAlive = serverKeepAlive
                });
            });

    private sealed class FixedTime(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
