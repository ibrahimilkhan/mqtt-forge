namespace MqttForge.Application.Alerts;

/// <summary>Every ceiling and every default the engine reads. One record, so a test can move
/// exactly one number and leave the rest where the shipped product has them.</summary>
public sealed record AlertEngineOptions
{
    public int DefaultWindow { get; init; } = 200;
    public int MinWindow { get; init; } = 20;
    public int MaxWindow { get; init; } = 2000;
    public int MaxPairs { get; init; } = 20_000;
    public int MaxReadings { get; init; } = 4_000_000;
    public int MaxTopicsPerRule { get; init; } = 1_000;
    public int MaxActiveAlerts { get; init; } = 1_000;
    public int HistoryDepth { get; init; } = 500;
    public int DefaultCooldownSeconds { get; init; } = 1;
    public int FreshnessSeconds { get; init; } = 60;
    public int ReplayWindowSeconds { get; init; } = 2;
    public int PatternTimeoutsBeforeDisable { get; init; } = 10;
    public string TopicPrefix { get; init; } = "mqttforge/alerts/";
}
