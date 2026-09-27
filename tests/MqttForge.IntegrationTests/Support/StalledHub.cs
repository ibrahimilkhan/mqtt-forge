using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Hubs;
using NSubstitute;

namespace MqttForge.IntegrationTests.Support;

/// <summary>
/// A hub whose sends of one method wait until their token calls them off — consoles that stopped
/// reading when that was sent — and whose other sends go through. It says which methods it was sent.
/// </summary>
public sealed class StalledHub
{
    private readonly ConcurrentQueue<string> _sent = new();
    private int _held;

    /// <param name="holding">The method whose sends are held, or null for a hub whose consoles all read.</param>
    public StalledHub(string? holding)
    {
        var proxy = Substitute.For<IClientProxy>();
        proxy
            .SendCoreAsync(Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                var method = call.ArgAt<string>(0);
                _sent.Enqueue(method);

                return method == holding ? HoldAsync(call.ArgAt<CancellationToken>(2)) : Task.CompletedTask;
            });

        var clients = Substitute.For<IHubClients>();
        clients.All.Returns(proxy);

        Context = Substitute.For<IHubContext<MqttHub>>();
        Context.Clients.Returns(clients);
    }

    public IHubContext<MqttHub> Context { get; }

    /// <summary>How many sends are waiting on the consoles right now.</summary>
    public int Held => Volatile.Read(ref _held);

    /// <summary>The method of every send, in the order they were made, held or not.</summary>
    public IReadOnlyList<string> Sent => [.. _sent];

    private async Task HoldAsync(CancellationToken ct)
    {
        Interlocked.Increment(ref _held);
        try
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, ct);
        }
        finally
        {
            Interlocked.Decrement(ref _held);
        }
    }
}
