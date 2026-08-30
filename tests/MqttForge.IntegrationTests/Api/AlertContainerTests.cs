using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Api;
using MqttForge.Domain.Abstractions;
using MqttForge.Infrastructure.Mqtt;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>
/// The one thing about this task's wiring that cannot be asked of a unit test: whether a real
/// host can be built at all once <c>IMessageNotifier</c> is the fan-out.
/// </summary>
// Task 7 adds AlertWiringTests beside this, which asks the fuller question — what every
// registration hands out, and in what order the hosted services start. This file exists on its
// own and now because the ring is opened now, and because its failure mode is not a red test: a
// container that walks IMqttSubscriber → IMessageNotifier → FanOutMessageNotifier → AlertEngine →
// IMqttSubscriber recurses until the stack ends, and a StackOverflowException cannot be caught.
// The runner dies, taking every other test in the assembly's report with it.
//
// So this passes before Step 3 as well as after, and that is the point. It is a guard rather than
// a red test: it is here to make the wrong version of Step 3 impossible to miss, and the wrong
// version does not fail an assertion, it removes the process.
//
// Nothing is started. The host is built, one service is resolved, and it is disposed: no port is
// bound, no hosted service runs, no file is written. All three paths are pinned anyway, because
// an unpinned one puts the app's files in the test runner's own directory.
public class AlertContainerTests
{
    private static WebApplication Host() =>
        MqttForgeHost.Build([
            $"--MqttForge:SettingsPath={Temp("container-settings")}",
            $"--MqttForge:AlertRulesPath={Temp("container-rules")}",
            $"--MqttForge:AlertStatePath={Temp("container-state")}"
        ]);

    private static string Temp(string what) =>
        Path.Combine(Path.GetTempPath(), $"mqttforge-{what}-{Guid.NewGuid():N}.json");

    [Fact]
    public async Task Building_the_host_does_not_walk_the_notifier_ring_forever()
    {
        await using var app = Host();

        var subscriber = app.Services.GetRequiredService<IMqttSubscriber>();

        // The resolution above is the assertion: MqttForgeHost.Build has already made it once on
        // its last line, and a container that could not answer it would never have reached here.
        // The two below say the answer is the real subscriber rather than the stand-in the engine
        // is handed — DeferredSubscriber is registered nowhere and must resolve to nothing.
        Assert.IsType<MqttnetSubscriber>(subscriber);
        Assert.Empty(subscriber.Filters);
    }
}
