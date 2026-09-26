namespace MqttForge.Application.Flows;

/// <summary>The ceilings the spec puts on what one flow may do, in one place.</summary>
// Every number here is a bound on work or memory that one person's drawing can cause on a server
// other people's alarms also run on. They are deliberately not settings: raising any of them is a
// decision about the product, and a configuration value would make it one about a deployment.
public static class FlowLimits
{
    public const int Flows = 50;
    public const int NodesPerFlow = 200;
    public const int EdgesPerFlow = 400;

    /// <summary>How many nodes one event may run before it is stopped.</summary>
    public const int StepsPerEvent = 10_000;

    public const int ForEachElements = 1_000;
    public const int RepeatCount = 1_000;

    /// <summary>How many Repeat sequences one node may have running at once.</summary>
    public const int RepeatSequences = 10;

    public static readonly TimeSpan MinInterval = TimeSpan.FromMilliseconds(100);
    public static readonly TimeSpan MaxEvery = TimeSpan.FromHours(24);
    public static readonly TimeSpan MaxRepeatInterval = TimeSpan.FromHours(1);

    public const int PublishesPerSecond = 50;

    /// <summary>How long a flow stays deaf to what it has just published.</summary>
    public static readonly TimeSpan EchoWindow = TimeSpan.FromSeconds(5);

    public const int EchoFingerprints = 1_000;

    /// <summary>The largest payload a Publish node will send, in bytes once encoded.</summary>
    public const int PayloadBytes = 64 * 1024;

    public const int TopicTemplateLength = 1_024;
    public const int NameLength = 80;
    public const int ReasonLength = 200;
    public const int SampleLength = 4_096;

    /// <summary>The note under a node on the canvas.</summary>
    public const int NoteLength = 80;

    public const int StandingShown = 20;
    public const int AlarmHistory = 100;
    public const int DebugPerPush = 100;
    public const int DebugExcerpt = 1_024;

    /// <summary>The fastest the console is told what the flows are doing.</summary>
    public static readonly TimeSpan StatusEvery = TimeSpan.FromMilliseconds(250);
}
