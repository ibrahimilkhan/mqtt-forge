using System.Net;
using System.Net.Http.Json;
using MqttForge.Api.Contracts;
using MqttForge.Domain.Enums;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Mqtt;

// Every way in, against one broker wearing every listener. See TransportMosquittoFixture.
public class TransportTests : IClassFixture<MqttForgeApiFactory>, IClassFixture<TransportMosquittoFixture>
{
    private readonly MqttForgeApiFactory _factory;
    private readonly TransportMosquittoFixture _broker;

    public TransportTests(MqttForgeApiFactory factory, TransportMosquittoFixture broker)
    {
        _factory = factory;
        _broker = broker;
    }

    [Fact]
    public async Task Plain_MQTT_over_TCP_still_connects()
    {
        var link = await Connect(Request("tcp", _broker.Plain));

        Assert.Equal(MqttTransport.Tcp, link.Transport);
        Assert.False(link.UseTls);
    }

    [Fact]
    public async Task MQTT_inside_a_WebSocket_connects_and_says_that_is_what_it_did()
    {
        var link = await Connect(
            Request("ws", _broker.WebSocket) with { Transport = MqttTransport.WebSocket });

        Assert.Equal(MqttTransport.WebSocket, link.Transport);
        Assert.False(link.UseTls);
    }

    [Fact]
    public async Task An_encrypted_WebSocket_connects_when_the_CA_is_named()
    {
        var link = await Connect(
            Request("wss", _broker.SecureWebSocket) with
            {
                Transport = MqttTransport.WebSocket,
                UseTls = true,
                Tls = new TlsOptionsDto(CertificateAuthorityPath: _broker.Certificates.AuthorityPath),
            });

        Assert.Equal(MqttTransport.WebSocket, link.Transport);
        Assert.True(link.UseTls);
    }

    // The commonest WebSocket mistake, and the one a broker's own answer explains worst: the
    // upgrade never happened, so what is on the other end is not a WebSocket at all.
    [Fact]
    public async Task A_WebSocket_pointed_at_a_plain_MQTT_port_says_the_upgrade_was_refused()
    {
        var client = _factory.CreateClient();
        var dto = Request("ws-wrong-port", _broker.Plain) with { Transport = MqttTransport.WebSocket };

        var response = await client.PostAsJsonAsync("/api/connection", dto);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Contains(
            "\"reason\":\"webSocketUpgradeRejected\"", await response.Content.ReadAsStringAsync());
    }

    // A version and a transport are independent, and nothing in the ladder assumes TCP.
    [Fact]
    public async Task An_older_version_travels_over_a_WebSocket_just_as_well()
    {
        var link = await Connect(
            Request("ws-311", _broker.WebSocket) with
            {
                Transport = MqttTransport.WebSocket,
                ProtocolVersion = MqttProtocolLevel.V311,
            });

        Assert.Equal(MqttProtocolLevel.V311, link.ProtocolVersion);
        Assert.Equal(MqttTransport.WebSocket, link.Transport);
    }

    private ConnectRequestDto Request(string clientId, int port) =>
        new(_broker.Host, port, clientId, null, null, false);

    private async Task<BrokerLinkDto> Connect(ConnectRequestDto dto)
    {
        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/connection", dto);
        Assert.True(
            response.IsSuccessStatusCode,
            $"connect failed: {await response.Content.ReadAsStringAsync()}");

        var state = await client.GetFromJsonAsync<StateResponse>("/api/connection", WireJson.Client);

        return state!.Connection!;
    }

    private sealed record StateResponse(string State, BrokerLinkDto? Connection);
}

// The parts of TLS a cloud broker needs, and the failures they leave when they are missing.
public class EncryptedTransportTests : IClassFixture<MqttForgeApiFactory>, IClassFixture<TransportMosquittoFixture>
{
    private readonly MqttForgeApiFactory _factory;
    private readonly TransportMosquittoFixture _broker;

    public EncryptedTransportTests(MqttForgeApiFactory factory, TransportMosquittoFixture broker)
    {
        _factory = factory;
        _broker = broker;
    }

    // The default, and the one that has to stay the default: a certificate signed by a CA
    // nothing on this machine knows is refused, and the refusal names the reason.
    [Fact]
    public async Task A_certificate_from_an_unknown_CA_is_refused()
    {
        await AssertRefused(Request("tls-strict", _broker.Tls), "tlsCertUntrusted");
    }

    // The honest answer to a private CA: the chain is still built, just to a root you named.
    [Fact]
    public async Task Naming_the_CA_makes_the_same_certificate_acceptable()
    {
        var link = await Connect(Request("tls-ca", _broker.Tls) with
        {
            Tls = new TlsOptionsDto(CertificateAuthorityPath: _broker.Certificates.AuthorityPath),
        });

        Assert.True(link.UseTls);
    }

    // The other answer, which is not verification at all. It has to work — a development broker
    // with a certificate it signed itself is the commonest thing anyone points this at — and it
    // has to be something somebody switched on.
    [Fact]
    public async Task Accepting_any_certificate_connects_where_verification_would_not()
    {
        var link = await Connect(Request("tls-loose", _broker.Tls) with
        {
            Tls = new TlsOptionsDto(AllowUntrustedCertificates: true),
        });

        Assert.True(link.UseTls);
    }

    // A CA that is not the broker's is not a way round anything.
    [Fact]
    public async Task Naming_the_wrong_CA_refuses_the_certificate_all_the_same()
    {
        using var unrelated = new TestCertificates();

        await AssertRefused(
            Request("tls-wrong-ca", _broker.Tls) with
            {
                Tls = new TlsOptionsDto(CertificateAuthorityPath: unrelated.AuthorityPath),
            },
            "tlsCertUntrusted");
    }

    // Mutual TLS: AWS IoT Core's only method, and how most locked-down brokers are configured.
    [Fact]
    public async Task A_client_certificate_gets_in_where_none_would()
    {
        var link = await Connect(Request("mtls", _broker.MutualTls) with
        {
            Tls = new TlsOptionsDto(
                CertificateAuthorityPath: _broker.Certificates.AuthorityPath,
                ClientCertificatePath: _broker.Certificates.ClientCertificatePath,
                ClientCertificatePassword: TestCertificates.ClientPassword),
        });

        Assert.True(link.UseTls);
    }

    // The same certificate as a PEM pair, which is the shape AWS hands you.
    [Fact]
    public async Task A_PEM_certificate_and_its_key_work_as_well_as_a_pfx()
    {
        var link = await Connect(Request("mtls-pem", _broker.MutualTls) with
        {
            Tls = new TlsOptionsDto(
                CertificateAuthorityPath: _broker.Certificates.AuthorityPath,
                ClientCertificatePath: _broker.Certificates.ClientPemPath,
                ClientCertificateKeyPath: _broker.Certificates.ClientKeyPath),
        });

        Assert.True(link.UseTls);
    }

    // The broker ends the handshake and says nothing about why. What is known is what was sent
    // to it, which is what separates these two.
    [Fact]
    public async Task A_broker_that_wants_a_client_certificate_and_gets_none_says_so()
    {
        await AssertRefused(
            Request("mtls-none", _broker.MutualTls) with
            {
                Tls = new TlsOptionsDto(CertificateAuthorityPath: _broker.Certificates.AuthorityPath),
            },
            "clientCertificateRequired");
    }

    [Fact]
    public async Task A_client_certificate_the_broker_does_not_know_is_reported_as_ours()
    {
        await AssertRefused(
            Request("mtls-stranger", _broker.MutualTls) with
            {
                Tls = new TlsOptionsDto(
                    CertificateAuthorityPath: _broker.Certificates.AuthorityPath,
                    ClientCertificatePath: _broker.Certificates.StrangerPath),
            },
            "clientCertificateRejected");
    }

    // Nothing has left this machine yet, and saying "the handshake failed" would send the
    // reader to look at the broker.
    [Fact]
    public async Task A_certificate_file_that_cannot_be_read_is_reported_as_a_file()
    {
        await AssertRefused(
            Request("mtls-missing", _broker.MutualTls) with
            {
                Tls = new TlsOptionsDto(
                    ClientCertificatePath: Path.Combine(_broker.Certificates.Directory, "absent.pfx")),
            },
            "certificateFileUnreadable");
    }

    [Fact]
    public async Task The_wrong_password_on_a_pfx_is_reported_as_a_file_too()
    {
        await AssertRefused(
            Request("mtls-password", _broker.MutualTls) with
            {
                Tls = new TlsOptionsDto(
                    ClientCertificatePath: _broker.Certificates.ClientCertificatePath,
                    ClientCertificatePassword: "not-the-password"),
            },
            "certificateFileUnreadable");
    }

    private ConnectRequestDto Request(string clientId, int port) =>
        new(_broker.Host, port, clientId, null, null, UseTls: true);

    private async Task<BrokerLinkDto> Connect(ConnectRequestDto dto)
    {
        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/connection", dto);
        Assert.True(
            response.IsSuccessStatusCode,
            $"connect failed: {await response.Content.ReadAsStringAsync()}");

        var state = await client.GetFromJsonAsync<StateResponse>("/api/connection", WireJson.Client);

        return state!.Connection!;
    }

    private async Task AssertRefused(ConnectRequestDto dto, string reason)
    {
        var client = _factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/connection", dto);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Contains($"\"reason\":\"{reason}\"", await response.Content.ReadAsStringAsync());
    }

    private sealed record StateResponse(string State, BrokerLinkDto? Connection);
}
