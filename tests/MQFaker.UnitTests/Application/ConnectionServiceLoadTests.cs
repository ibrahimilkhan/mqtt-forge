using Microsoft.Extensions.Logging;
using MQFaker.Application.Services;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Models;
using NSubstitute;
using Xunit;

namespace MQFaker.UnitTests.Application;

public class ConnectionServiceLoadTests
{
    private readonly IMqttConnectionManager _manager = Substitute.For<IMqttConnectionManager>();
    private readonly IConnectionSettingsStore _store = Substitute.For<IConnectionSettingsStore>();
    private readonly ILogger<ConnectionService> _logger = Substitute.For<ILogger<ConnectionService>>();

    private ConnectionService CreateSut() => new(_manager, _store, _logger);

    [Fact]
    public async Task GetSavedSettingsAsync_returns_stored_settings()
    {
        var saved = new BrokerConnectionSettings("broker.local", 8883, "client-1", "user", "pass", true);
        _store.LoadAsync(Arg.Any<CancellationToken>()).Returns(saved);
        var sut = CreateSut();

        var result = await sut.GetSavedSettingsAsync(CancellationToken.None);

        Assert.Equal(saved, result);
    }

    [Fact]
    public async Task GetSavedSettingsAsync_returns_null_when_nothing_saved()
    {
        _store.LoadAsync(Arg.Any<CancellationToken>()).Returns((BrokerConnectionSettings?)null);
        var sut = CreateSut();

        var result = await sut.GetSavedSettingsAsync(CancellationToken.None);

        Assert.Null(result);
    }
}
