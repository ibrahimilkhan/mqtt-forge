using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// Shared setup for the engine's lifecycle tests.
///
/// The core has no clock, so every one of these tests is a sequence of OnMessage/OnTick calls
/// with the moment written into the call. No FakeTimeProvider, no Task.Delay, and no pump: the
/// same input always produces the same output, and a failing test names a second rather than a
/// race.
/// </summary>
internal static class AlertEngineFixture
{
    /// A round moment, so a failure reads as seconds since the start of the story.
    public static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    public const string Topic = "plant/boiler/temp";

    /// A pattern NonBacktracking refuses (the lookbehind) whose shape backtracks exponentially,
    /// so it lands on the timed engine and blows its 50 ms budget. `(a+)+$` alone will not do:
    /// NonBacktracking takes that one and answers it in linear time.
    public const string CatastrophicPattern = @"^(a+)+$(?<!z)";

    /// 4 kB, the spec's ceiling on the text a pattern is shown, ending in a byte that cannot
    /// match — only failure backtracks.
    public static readonly string HostilePayload = new string('a', 4000) + "b";

    public static AlertEngineCore Core(params AlertRule[] rules)
    {
        var core = new AlertEngineCore(new AlertEngineOptions());
        core.SetRules(rules, T0);
        return core;
    }

    public static AlertRule Rule(
        AlertCondition condition,
        AlertCondition? clear = null,
        int? forSeconds = null,
        int? cooldown = null,
        string filter = Topic,
        string? field = null,
        string id = "r1",
        string name = "Boiler temperature",
        bool enabled = true,
        AlertSeverity severity = AlertSeverity.Critical)
        => new(id, name, enabled, filter, field, condition, clear, forSeconds, cooldown,
               severity, [new ScreenAction()]);

    // Both clocks are given the same value on purpose. ReceivedAt and 'now' are separate in the
    // engine — a message that waited in the queue keeps its own arrival time — but a test that
    // moved them apart everywhere would be testing the queue, not the lifecycle.
    public static MqttMessage Message(string payload, DateTimeOffset at, string topic = Topic)
        => new(topic, payload, "text", Qos: 0, Retain: false, ReceivedAt: at);

    public static ThresholdCondition Above(double value) => new(ThresholdOp.Gt, value);

    public static ThresholdCondition Below(double value) => new(ThresholdOp.Lt, value);
}
