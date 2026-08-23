using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MQTTnet;
using MQTTnet.Exceptions;
using MQTTnet.Formatter;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

// What Auto tries, and — the half a real broker cannot show — what it declines to try again.
//
// The integration suite proves the ladder against mosquitto 1.5, which is the only honest way
// to know a v3-only broker's refusal is caught. It cannot show that a wrong password is asked
// once rather than three times, because the broker answers identically each time and the reader
// only sees the delay. That is what these are for.
public class VersionLadderTests
{
    private readonly IMqttClient _client = Substitute.For<IMqttClient>();
    private readonly IConnectionStateNotifier _notifier = Substitute.For<IConnectionStateNotifier>();
    private readonly BrokerConnectionSettings _settings = new("localhost", 1883, "id", null, null, false);
    private readonly List<MqttProtocolVersion> _offered = [];

    private MqttnetConnectionManager CreateSut() => new(new MqttnetClientProvider(_client), _notifier);

    // Every CONNECT the manager sends, in order, whatever came back.
    private void Record(Func<int, Task<MqttClientConnectResult>> answer) =>
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                _offered.Add(call.Arg<MqttClientOptions>()!.ProtocolVersion);
                return answer(_offered.Count - 1);
            });

    private static MqttClientConnectResult Connack(MqttClientConnectResultCode code) =>
        new() { ResultCode = code };

    [Fact]
    public async Task Auto_offers_5_first_and_stops_there_when_it_is_taken()
    {
        Record(_ =>
        {
            _client.IsConnected.Returns(true);
            return Task.FromResult(Connack(MqttClientConnectResultCode.Success));
        });

        await CreateSut().ConnectAsync(_settings, CancellationToken.None);

        Assert.Equal([MqttProtocolVersion.V500], _offered);
    }

    // The refusal an MQTT 5 broker sends, and the one a v3-only broker's CONNACK carries as a
    // bare 1 in the space v5 leaves unused.
    [Theory]
    [InlineData(MqttClientConnectResultCode.UnsupportedProtocolVersion)]
    [InlineData((MqttClientConnectResultCode)1)]
    public async Task A_refused_version_moves_the_ladder_on(MqttClientConnectResultCode refusal)
    {
        Record(attempt =>
        {
            if (attempt == 0) return Task.FromResult(Connack(refusal));
            _client.IsConnected.Returns(true);
            return Task.FromResult(Connack(MqttClientConnectResultCode.Success));
        });

        await CreateSut().ConnectAsync(_settings, CancellationToken.None);

        Assert.Equal([MqttProtocolVersion.V500, MqttProtocolVersion.V311], _offered);
    }

    // How most v3-only brokers actually refuse: the socket closes with no CONNACK at all, which
    // MQTTnet hands over as a bare communication failure. Measured against mosquitto 1.5.
    [Fact]
    public async Task A_broker_that_closes_without_answering_moves_the_ladder_on_too()
    {
        Record(attempt =>
        {
            if (attempt < 2)
                return Task.FromException<MqttClientConnectResult>(
                    new MqttCommunicationException("Connection closed."));
            _client.IsConnected.Returns(true);
            return Task.FromResult(Connack(MqttClientConnectResultCode.Success));
        });

        await CreateSut().ConnectAsync(_settings, CancellationToken.None);

        Assert.Equal(
            [MqttProtocolVersion.V500, MqttProtocolVersion.V311, MqttProtocolVersion.V310], _offered);
    }

    // The rule that keeps Auto cheap. A wrong password, an untrusted certificate and an
    // unreachable host mean the same thing at every version; retrying them twice more only
    // makes the reader wait three times as long for the same sentence.
    [Theory]
    [InlineData(MqttClientConnectResultCode.BadUserNameOrPassword)]
    [InlineData(MqttClientConnectResultCode.NotAuthorized)]
    [InlineData(MqttClientConnectResultCode.Banned)]
    [InlineData(MqttClientConnectResultCode.ClientIdentifierNotValid)]
    [InlineData(MqttClientConnectResultCode.ServerUnavailable)]
    public async Task A_refusal_that_is_not_about_the_version_is_asked_once(
        MqttClientConnectResultCode refusal)
    {
        Record(_ => Task.FromResult(Connack(refusal)));

        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => CreateSut().ConnectAsync(_settings, CancellationToken.None));

        Assert.Single(_offered);
    }

    [Fact]
    public async Task A_host_that_is_not_there_is_not_asked_three_times()
    {
        Record(_ => Task.FromException<MqttClientConnectResult>(
            new MqttCommunicationException(new System.Net.Sockets.SocketException(61))));

        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => CreateSut().ConnectAsync(_settings, CancellationToken.None));

        Assert.Single(_offered);
    }

    // A version chosen by hand is a question about that version. Answering it by quietly
    // connecting on another one would make the setting useless for what it is for — finding out
    // what a broker does.
    [Fact]
    public async Task A_version_asked_for_by_name_is_never_swapped_for_another()
    {
        Record(_ => Task.FromResult(Connack(MqttClientConnectResultCode.UnsupportedProtocolVersion)));

        var failure = await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => CreateSut().ConnectAsync(
                _settings with { ProtocolVersion = MqttProtocolLevel.V500 }, CancellationToken.None));

        Assert.Equal([MqttProtocolVersion.V500], _offered);
        Assert.Equal(BrokerFailureReason.ProtocolVersionUnsupported, failure.Reason);
    }

    // Auto having walked the whole ladder is a different sentence from one version being
    // refused: the fix the second one suggests has already been tried.
    [Fact]
    public async Task Auto_running_out_of_versions_says_so_rather_than_naming_one()
    {
        Record(_ => Task.FromResult(Connack(MqttClientConnectResultCode.UnsupportedProtocolVersion)));
        var sut = CreateSut();

        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        Assert.Equal(
            [MqttProtocolVersion.V500, MqttProtocolVersion.V311, MqttProtocolVersion.V310], _offered);
        Assert.Equal(BrokerFailureReason.NoSupportedProtocolVersion, sut.Failure!.Reason);
    }

    // Nothing is announced between rungs. A Faulted flashing past on the way to a link that
    // came up would be a lie about a connection that is about to work.
    [Fact]
    public async Task The_console_is_not_told_about_a_rung_the_ladder_stepped_off()
    {
        Record(attempt =>
        {
            if (attempt == 0)
                return Task.FromResult(Connack(MqttClientConnectResultCode.UnsupportedProtocolVersion));
            _client.IsConnected.Returns(true);
            return Task.FromResult(Connack(MqttClientConnectResultCode.Success));
        });

        await CreateSut().ConnectAsync(_settings, CancellationToken.None);

        await _notifier.DidNotReceive().NotifyStateChangedAsync(
            ConnectionState.Faulted, Arg.Any<BrokerFailure?>(), Arg.Any<BrokerLink?>());
    }

    // The version that was accepted, not the one that was asked for — with Auto choosing, those
    // are different things, and this is the only place the reader can see which they got.
    [Fact]
    public async Task The_link_reports_the_version_that_was_accepted()
    {
        Record(attempt =>
        {
            if (attempt < 2)
                return Task.FromResult(Connack(MqttClientConnectResultCode.UnsupportedProtocolVersion));
            _client.IsConnected.Returns(true);
            return Task.FromResult(Connack(MqttClientConnectResultCode.Success));
        });
        var sut = CreateSut();

        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.Equal(MqttProtocolLevel.V310, sut.Link!.ProtocolVersion);
    }

    // A failure carries the endpoint it was about, and how it was being reached — the console
    // reads both off the connection state long after the form that made the attempt has gone.
    [Fact]
    public async Task A_failure_says_how_the_connection_was_being_made()
    {
        Record(_ => Task.FromResult(Connack(MqttClientConnectResultCode.NotAuthorized)));
        var sut = CreateSut();
        var overWebSocket = _settings with
        {
            Transport = MqttTransport.WebSocket,
            ProtocolVersion = MqttProtocolLevel.V311,
        };

        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(overWebSocket, CancellationToken.None));

        Assert.Equal(MqttTransport.WebSocket, sut.Failure!.Transport);
        Assert.Equal(MqttProtocolLevel.V311, sut.Failure.ProtocolVersion);
    }
}
