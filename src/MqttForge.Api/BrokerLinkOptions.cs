using Microsoft.Extensions.Configuration;

namespace MqttForge.Api;

/// <summary>What the host is allowed to do with the broker link before anybody asks it to.</summary>
/// <param name="ConnectOnStart">Whether start-up dials the saved broker when an alert rule is
/// enabled. On for a server, so a container evaluates rules with nobody watching; off for the
/// desktop app, which opens on the Broker panel and lets the reader press Connect.</param>
// A record of its own rather than a bool on the supervisor's constructor, because the container
// fills constructor parameters from registered services and a bool has nowhere to come from. It
// is read the way AlertEngineOptions is — at resolve time, so a late-configuring test host still
// gets the value it set.
public sealed record BrokerLinkOptions(bool ConnectOnStart)
{
    /// <summary>A server's defaults: dial at start-up if the rules want a broker.</summary>
    // True, because the supervisor exists so that a headless MQTTForge goes on evaluating rules
    // across a restart. The desktop app is the one that says otherwise, and it says so itself
    // (see DesktopBind) rather than being told apart here by guessing whether a window exists.
    public static readonly BrokerLinkOptions Shipped = new(ConnectOnStart: true);

    /// <summary>The shipped defaults with MqttForge:ConnectOnStart laid over them.</summary>
    // Only 'true' and 'false' are answers, exactly as AllowWebhooks is read: an unreadable value
    // leaves the shipped default standing rather than silently turning the dial off.
    public static BrokerLinkOptions From(IConfiguration config) =>
        Shipped with
        {
            ConnectOnStart = !bool.TryParse(config["MqttForge:ConnectOnStart"], out var connect) || connect
        };
}
