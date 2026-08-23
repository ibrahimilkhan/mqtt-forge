using MqttForge.Api;
using Xunit;

namespace MqttForge.UnitTests.Api;

/// <summary>
/// The app answers to addresses and refuses names, and the reason is DNS rebinding: a name is the
/// only part of a request an attacker can point somewhere else after the browser has decided what
/// its origin is. Without this, publishing the port on loopback — the README's own way of keeping
/// the app to one machine — kept out everyone except a page the reader was shown.
/// </summary>
public class HostGuardTests
{
    // Every documented way of reaching this app: the container on localhost, the desktop window on
    // its LAN address, a phone off the QR panel, the dev server's proxy.
    [Theory]
    [InlineData("localhost")]
    [InlineData("LOCALHOST")]
    [InlineData("app.localhost")]
    [InlineData("127.0.0.1")]
    [InlineData("0.0.0.0")]
    [InlineData("192.168.1.24")]
    [InlineData("10.0.0.7")]
    [InlineData("::1")]
    [InlineData("fe80::1c2b:3d4e:5f60:7a8b")]
    public void Answers_to_an_address_or_to_localhost(string host) =>
        Assert.True(HostGuard.IsAllowed(host));

    // mDNS rather than DNS: answered on the link, not by a resolver a stranger can aim. Reaching
    // the machine by its Bonjour name is ordinary on macOS and Linux, and the dev server's own
    // network-url plugin prefers it.
    [Theory]
    [InlineData("kitchen-pi.local")]
    [InlineData("Studio.local")]
    public void Answers_to_a_bonjour_name(string host) =>
        Assert.True(HostGuard.IsAllowed(host));

    // Nothing to rebind: HTTP/1.0, or a probe that named nothing.
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void Answers_when_no_host_was_named(string? host) =>
        Assert.True(HostGuard.IsAllowed(host));

    // The shape of the attack: a name the attacker's own resolver answers for, pointed at
    // loopback once the browser has already fixed the page's origin on it.
    [Theory]
    [InlineData("evil.example")]
    [InlineData("rebind.attacker.test")]
    [InlineData("mqtt-forge.example.com")]
    // Close enough to fool a suffix match written the lazy way, and not the same name.
    [InlineData("notlocalhost")]
    [InlineData("localhost.evil.example")]
    [InlineData("local")]
    [InlineData("mylocal")]
    public void Refuses_a_name(string host) =>
        Assert.False(HostGuard.IsAllowed(host));
}
