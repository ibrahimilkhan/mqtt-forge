using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MQTTnet;
using MQTTnet.Exceptions;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

// Who holds the client certificate an attempt reads from its file, and when it is let go.
//
// A certificate loaded with its key is more than memory. On macOS every load is a temporary
// keychain in $TMPDIR, and on Windows a key written into the user's store, and either stays until
// the certificate is disposed or finalized, which the end of a process does not wait for. Nothing
// disposed them. An attempt now owns what it loaded until it makes a link, the link owns it after
// that, and whichever of the two is over lets it go.
[Collection(ClientCertificateFiles.Collection)]
public sealed class MqttnetConnectionManagerCertificateTests(ClientCertificateFiles files) : IDisposable
{
    private readonly IMqttClient _client = Substitute.For<IMqttClient>();
    private readonly IConnectionStateNotifier _notifier = Substitute.For<IConnectionStateNotifier>();

    // The certificate MQTTnet was handed with each CONNECT, in order.
    private readonly List<X509Certificate2> _presented = [];

    // Every manager a test made, stopped when the test is over, as the host stops its own. A test
    // that ends with a link up leaves that link its certificate, and a keychain in $TMPDIR with it,
    // until something lets the manager go.
    private readonly List<MqttnetConnectionManager> _made = [];

    private BrokerConnectionSettings Mutual => new(
        "localhost", 8884, "id", null, null, UseTls: true, ProtocolVersion: MqttProtocolLevel.V500,
        Tls: new BrokerTlsSettings(
            ClientCertificatePath: files.Pfx, ClientCertificatePassword: ClientCertificateFiles.Password));

    private MqttnetConnectionManager CreateSut(TimeSpan? connectTimeout = null)
    {
        var sut = new MqttnetConnectionManager(new MqttnetClientProvider(_client), _notifier, connectTimeout);
        _made.Add(sut);
        return sut;
    }

    public void Dispose()
    {
        foreach (var sut in _made) sut.Dispose();
    }

    public enum Failure { Unreachable, Refused, TimedOut, CalledOff }

    // Whichever way it fails, MQTTnet has closed the attempt's channel by the time ConnectAsync
    // comes back, and nothing will present that certificate again.
    [Theory]
    [InlineData(Failure.Unreachable)]
    [InlineData(Failure.Refused)]
    [InlineData(Failure.TimedOut)]
    [InlineData(Failure.CalledOff)]
    public async Task The_certificate_an_attempt_loaded_is_let_go_when_the_attempt_fails(Failure failure)
    {
        using var caller = new CancellationTokenSource();
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                Present(call.Arg<MqttClientOptions>()!);

                return failure switch
                {
                    Failure.Unreachable => Task.FromException<MqttClientConnectResult>(
                        new MqttCommunicationException(new SocketException((int)SocketError.ConnectionRefused))),
                    Failure.Refused => Task.FromResult(Connack(MqttClientConnectResultCode.NotAuthorized)),
                    Failure.TimedOut => Unanswered(call.Arg<CancellationToken>()),
                    _ => CalledOff(caller),
                };
            });

        await Assert.ThrowsAnyAsync<Exception>(
            () => CreateSut(connectTimeout: TimeSpan.FromMilliseconds(50)).ConnectAsync(Mutual, caller.Token));

        Assert.True(Disposed(Assert.Single(_presented)));
    }

    // Our certificate is read before the CA file, and a CA file that cannot be read ends the attempt
    // before MQTTnet is handed anything, so only what it leaves behind can show it went. macOS is
    // where that shows: a keychain in $TMPDIR.
    [Fact]
    public async Task A_certificate_read_before_a_CA_file_that_cannot_be_read_is_let_go_all_the_same()
    {
        if (!OperatingSystem.IsMacOS()) return;

        var before = ClientCertificateFiles.Keychains();
        var settings = Mutual with
        {
            Tls = Mutual.TlsSettings with { CertificateAuthorityPath = Path.Combine(files.Directory, "absent.crt") },
        };

        var error = await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => CreateSut().ConnectAsync(settings, CancellationToken.None));

        Assert.Equal(BrokerFailureReason.CertificateFileUnreadable, error.Reason);
        Assert.Empty(ClientCertificateFiles.Keychains().Except(before));
    }

    // Auto walks three versions against a broker that refuses each of them: three loads, and all
    // three let go, not only the last.
    [Fact]
    public async Task Every_version_the_ladder_tries_lets_its_own_certificate_go()
    {
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                Present(call.Arg<MqttClientOptions>()!);
                return Task.FromResult(Connack(MqttClientConnectResultCode.UnsupportedProtocolVersion));
            });

        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => CreateSut().ConnectAsync(Mutual with { ProtocolVersion = MqttProtocolLevel.Auto }, CancellationToken.None));

        // By reference: two loads of one file are Equal to each other, as certificates.
        Assert.Equal(3, _presented.Distinct(ReferenceEqualityComparer.Instance).Count());
        Assert.All(_presented, certificate => Assert.True(Disposed(certificate)));
    }

    // MQTTnet allows renegotiation, and a broker that asks for our certificate again in the middle
    // of a session is asking for this one: it lives as long as the link does.
    [Fact]
    public async Task The_certificate_stays_with_the_link_it_made()
    {
        GivenConnectSucceeds();

        await CreateSut().ConnectAsync(Mutual, CancellationToken.None);

        Assert.False(Disposed(Assert.Single(_presented)));
    }

    public enum End { ReaderDisconnects, BrokerDrops, HostStops }

    [Theory]
    [InlineData(End.ReaderDisconnects)]
    [InlineData(End.BrokerDrops)]
    [InlineData(End.HostStops)]
    public async Task The_certificate_is_let_go_when_the_link_it_served_ends(End end)
    {
        GivenConnectSucceeds();
        GivenDisconnectSucceeds();
        var sut = CreateSut();
        await sut.ConnectAsync(Mutual, CancellationToken.None);

        switch (end)
        {
            case End.ReaderDisconnects:
                await sut.DisconnectAsync(CancellationToken.None);
                break;

            case End.BrokerDrops:
                _client.IsConnected.Returns(false);
                RaiseDisconnected();
                break;

            case End.HostStops:
                sut.Dispose();
                break;
        }

        Assert.True(Disposed(Assert.Single(_presented)));
    }

    [Fact]
    public async Task A_dial_that_replaces_the_link_lets_its_certificate_go_and_keeps_its_own()
    {
        GivenConnectSucceeds();
        GivenDisconnectSucceeds();
        var sut = CreateSut();
        await sut.ConnectAsync(Mutual, CancellationToken.None);

        await sut.ConnectAsync(Mutual, CancellationToken.None);

        Assert.Equal(2, _presented.Count);
        Assert.True(Disposed(_presented[0]));
        Assert.False(Disposed(_presented[1]));
    }

    // MQTTnet raises a drop from a task of its own, and the one for the link a dial replaced can land
    // after the new link is up. It is about the old link, whose certificate has gone already.
    [Fact]
    public async Task A_drop_told_after_a_newer_link_came_up_leaves_that_link_its_certificate()
    {
        GivenConnectSucceeds();
        GivenDisconnectSucceeds();
        var sut = CreateSut();
        await sut.ConnectAsync(Mutual, CancellationToken.None);
        await sut.ConnectAsync(Mutual, CancellationToken.None);

        RaiseDisconnected();

        Assert.False(Disposed(_presented[1]));
    }

    // A duplicate client id: the broker takes the CONNECT and closes the session before
    // ConnectAsync is back, so the drop is told before there is a link to hand the certificate to.
    [Fact]
    public async Task A_link_the_broker_ends_as_it_opens_lets_its_certificate_go()
    {
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                Present(call.Arg<MqttClientOptions>()!);
                _client.IsConnected.Returns(false);
                RaiseDisconnected();
                return Task.FromResult(Connack(MqttClientConnectResultCode.Success));
            });

        await CreateSut().ConnectAsync(Mutual, CancellationToken.None);

        Assert.True(Disposed(Assert.Single(_presented)));
    }

    // Dispose empties a certificate, and an empty one has no handle.
    private static bool Disposed(X509Certificate2 certificate) => certificate.Handle == IntPtr.Zero;

    private void Present(MqttClientOptions options) =>
        _presented.Add((X509Certificate2)Assert.Single(
            options.ChannelOptions.TlsOptions.ClientCertificatesProvider.GetCertificates())!);

    // The real client flips IsConnected as part of connecting; a substitute has to be told to.
    private void GivenConnectSucceeds() =>
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                Present(call.Arg<MqttClientOptions>()!);
                _client.IsConnected.Returns(true);
                return Task.FromResult(Connack(MqttClientConnectResultCode.Success));
            });

    private void GivenDisconnectSucceeds() =>
        _client.DisconnectAsync(Arg.Any<MqttClientDisconnectOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(false);
                return Task.CompletedTask;
            });

    private static MqttClientConnectResult Connack(MqttClientConnectResultCode code) => new() { ResultCode = code };

    // A broker that takes the socket and says nothing, until the attempt's own deadline calls it off.
    private static async Task<MqttClientConnectResult> Unanswered(CancellationToken token)
    {
        await Task.Delay(Timeout.Infinite, token);
        return Connack(MqttClientConnectResultCode.Success);
    }

    private static Task<MqttClientConnectResult> CalledOff(CancellationTokenSource caller)
    {
        caller.Cancel();
        return Task.FromException<MqttClientConnectResult>(new OperationCanceledException(caller.Token));
    }

    private void RaiseDisconnected() =>
        _client.DisconnectedAsync += Raise.Event<Func<MqttClientDisconnectedEventArgs, Task>>(
            new MqttClientDisconnectedEventArgs(
                clientWasConnected: true,
                connectResult: null,
                reason: MqttClientDisconnectReason.UnspecifiedError,
                reasonString: null,
                userProperties: null,
                exception: null));
}
