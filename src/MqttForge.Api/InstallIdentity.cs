using System.Security.Cryptography;

namespace MqttForge.Api;

/// <summary>The client ID a fresh form is filled with, made this install's own.</summary>
// MQTT allows one client of a given ID on a broker at a time: a second one connecting takes the
// link from the first, which then reconnects and takes it back, once a second, for as long as
// both are running. Every install shipped the same default — 'mqttforge-console' — so two
// MQTTForges pointed at one broker did exactly that to each other, and the fight looked from
// either side like a broker that would not hold a connection.
//
// The supervisor already declines a takeover rather than joining in (see BrokerLinkSupervisor),
// which stops this console fighting; it cannot stop the other one. Not colliding in the first
// place is the fix, and four hex characters are enough: two installs meeting on one broker have
// one chance in 65,536 of choosing the same one, against the certainty they had before.
//
// Stable across restarts, because a client ID that changed on every start would leave a trail of
// abandoned sessions on brokers that keep them, and would make 'who is connected' unreadable on
// a broker's own dashboard.
public sealed class InstallIdentity
{
    /// <summary>What the console suggests when nothing has been saved yet.</summary>
    public const string Stem = "mqttforge-console";

    private readonly string _path;
    private readonly ILogger<InstallIdentity> _log;
    private string? _clientId;
    private readonly Lock _gate = new();

    public InstallIdentity(string path, ILogger<InstallIdentity> log)
    {
        _path = path;
        _log = log;
    }

    /// <summary>`mqttforge-console-a7f3`, the same one every time this install is asked.</summary>
    public string DefaultClientId
    {
        get
        {
            lock (_gate) return _clientId ??= $"{Stem}-{Token()}";
        }
    }

    private string Token()
    {
        try
        {
            if (File.Exists(_path))
            {
                var held = File.ReadAllText(_path).Trim();
                if (IsToken(held)) return held;
            }

            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(2)).ToLowerInvariant();

            Directory.CreateDirectory(Path.GetDirectoryName(_path) ?? ".");
            File.WriteAllText(_path, token);

            return token;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A read-only install directory — a DMG, a locked-down container. The suffix is a
            // courtesy and not a requirement, so an unwritable one costs a warning and the bare
            // stem, which is what every install used before this existed.
            _log.LogWarning(ex, "Could not keep this install's client-ID token; using the shared default.");

            return string.Empty;
        }
    }

    // Four hex characters and nothing else: a file somebody edited by hand, or half-written by a
    // crash, must not become a client ID the broker refuses.
    private static bool IsToken(string value) =>
        value.Length == 4 && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
}
