using System.Net;
using System.Net.Http.Json;
using MQFaker.Api.Contracts;
using MQFaker.IntegrationTests.Support;
using Xunit;

namespace MQFaker.IntegrationTests.Api;

// Two more ways a real deployment's connect attempt can fail before ever exchanging a message
public class WrongCredentialsTests : IClassFixture<MqFakerApiFactory>, IClassFixture<LockedMosquittoFixture>
{
    private readonly MqFakerApiFactory _factory;
    private readonly LockedMosquittoFixture _broker;

    public WrongCredentialsTests(MqFakerApiFactory factory, LockedMosquittoFixture broker)
    {
        _factory = factory;
        _broker = broker;
    }

    [Fact]
    public async Task Connect_with_credentials_the_broker_rejects_reports_faulted_not_a_500()
    {
        var client = _factory.CreateClient();
        var dto = new ConnectRequestDto(_broker.Host, _broker.Port, "wrong-creds", "someone", "not-the-password", false);

        // The broker sends CONNACK "not authorised" then closes the socket - MQTTnet's
        // ConnectAsync returns rather than throwing, so this is the same "closed right after
        // connecting" case ConnectionManager already reports as Faulted, not an exception.
        var response = await client.PostAsJsonAsync("/api/connection", dto);

        response.EnsureSuccessStatusCode();
        Assert.Contains("\"state\":\"Faulted\"", await response.Content.ReadAsStringAsync());

        var state = await client.GetAsync("/api/connection");
        Assert.Contains("Faulted", await state.Content.ReadAsStringAsync());
    }
}

public class TlsMismatchTests : IClassFixture<MqFakerApiFactory>, IClassFixture<MosquittoFixture>
{
    private readonly MqFakerApiFactory _factory;
    private readonly MosquittoFixture _broker;

    public TlsMismatchTests(MqFakerApiFactory factory, MosquittoFixture broker)
    {
        _factory = factory;
        _broker = broker;
    }

    [Fact]
    public async Task Connect_with_tls_to_a_plaintext_broker_returns_502_not_a_hang()
    {
        var client = _factory.CreateClient();
        // The fixture's listener speaks plain MQTT; asking for TLS against it is the
        // mismatch a wrong port or a misconfigured broker produces in the field.
        var dto = new ConnectRequestDto(_broker.Host, _broker.Port, "tls-mismatch", null, null, true);

        var response = await client.PostAsJsonAsync("/api/connection", dto)
            .WaitAsync(TimeSpan.FromSeconds(15));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
    }
}
