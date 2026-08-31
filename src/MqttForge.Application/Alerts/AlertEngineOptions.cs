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
    public int PatternTimeoutsBeforeDisable { get; init; } = 10;
    public string TopicPrefix { get; init; } = "mqttforge/alerts/";


        /// <summary>Whether a rule's webhook action is delivered at all.</summary>
        // The odd one out on this record: every other member is a number the engine reads, and this
        // is a switch an operator turns. It lives here anyway, because there are exactly two things
        // an operator can turn and the other one — TopicPrefix — is already on this record. A second
        // options type for one boolean would mean a second registration, a second thing to inject
        // and a second place to look for 'what did they configure'.
        //
        // True is what ships: the spec's "Webhook varsayılan açık, kapatılabilir, ve belgeli". Read
        // by the dispatcher in part 3; declared now so the whole configuration surface lands in one
        // commit rather than arriving later as a change to a record everything already holds.
        //
        // The replay window is deliberately not on this record. Task 1 deleted the unused
        // ReplayWindowSeconds from here and put the real one on MqttnetSubscriber.ReplayWindow,
        // because the subscriber is the only side that knows when the SUBACK arrived — putting a
        // second copy back here would give one setting two homes again.
        public bool AllowWebhooks { get; init; } = true;
}
