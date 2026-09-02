using Microsoft.Extensions.Configuration;

namespace MqttForge.Api;

/// <summary>What the host is allowed to do with the broker link before anybody asks it to.</summary>
/// <param name="ConnectOnStart">Whether start-up dials the saved broker when an alert rule is
/// enabled. Off unless somebody turns it on: the console opens on the Broker panel and the reader
/// presses Connect. The Docker image turns it on, because a container has nobody to press it.</param>
// A record of its own rather than a bool on the supervisor's constructor, because the container
// fills constructor parameters from registered services and a bool has nowhere to come from. It
// is read the way AlertEngineOptions is — at resolve time, so a late-configuring test host still
// gets the value it set.
public sealed record BrokerLinkOptions(bool ConnectOnStart)
{
    /// <summary>The shipped defaults: nothing is dialled until somebody asks.</summary>
    // Off, and off everywhere rather than told apart by guessing whether a window exists. A
    // process that dials out on every start because somebody once saved a host and enabled a
    // rule is a surprise on a desktop, and it is a surprise on a developer's `dotnet run` too.
    // The one host that really has nobody to press Connect is the container, and the Dockerfile
    // says so with MqttForge__ConnectOnStart=true — one line, where the reader of that file is.
    public static readonly BrokerLinkOptions Shipped = new(ConnectOnStart: false);

    /// <summary>The shipped defaults with MqttForge:ConnectOnStart laid over them.</summary>
    // Only 'true' and 'false' are answers, exactly as AllowWebhooks is read: an unreadable value
    // leaves the shipped default standing rather than dialling a broker on a typo.
    public static BrokerLinkOptions From(IConfiguration config) =>
        Shipped with
        {
            ConnectOnStart = bool.TryParse(config["MqttForge:ConnectOnStart"], out var connect)
                ? connect
                : Shipped.ConnectOnStart
        };
}
