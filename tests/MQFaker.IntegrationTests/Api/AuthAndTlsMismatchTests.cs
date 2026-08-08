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
    public async Task Connect_with_credentials_the_broker_rejects_returns_502_saying_so()
    {
        var client = _factory.CreateClient();
        var dto = new ConnectRequestDto(_broker.Host, _broker.Port, "wrong-creds", "someone", "not-the-password", false);

        // Broker sends CONNACK "not authorised" then closes; MQTTnet returns that as a
        // result rather than throwing, so the refusal has to be read off the result code
        var response = await client.PostAsJsonAsync("/api/connection", dto);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Contains("\"reason\":\"credentialsRejected\"", await response.Content.ReadAsStringAsync());

        var state = await client.GetAsync("/api/connection");
        Assert.Contains("Faulted", await state.Content.ReadAsStringAsync());
    }

    // Mosquitto answers this with the same code as a wrong password. What separates them is
    // that nothing was typed — advice the broker cannot give and we can.
    [Fact]
    public async Task Connect_with_no_credentials_to_a_broker_that_wants_them_says_so()
    {
        var client = _factory.CreateClient();
        var dto = new ConnectRequestDto(_broker.Host, _broker.Port, "no-creds", null, null, false);

        var response = await client.PostAsJsonAsync("/api/connection", dto);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Contains("\"reason\":\"credentialsRequired\"", await response.Content.ReadAsStringAsync());
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
        // Fixture speaks plain MQTT; TLS request mimics a real misconfigured-broker mismatch
        var dto = new ConnectRequestDto(_broker.Host, _broker.Port, "tls-mismatch", null, null, true);

        var response = await client.PostAsJsonAsync("/api/connection", dto)
            .WaitAsync(TimeSpan.FromSeconds(15));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        // The handshake ends in a bare IOException naming no cause, so only the TLS setting
        // tells us the port simply does not speak it — which is the actionable half.
        Assert.Contains("\"reason\":\"tlsNotOffered\"", await response.Content.ReadAsStringAsync());
    }
}
