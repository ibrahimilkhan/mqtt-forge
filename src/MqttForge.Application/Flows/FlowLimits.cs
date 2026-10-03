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

    public const int ForEachElements = 1_000;

    public const int PublishesPerSecond = 50;

    /// <summary>How long a flow stays deaf to what it has just published.</summary>
    public static readonly TimeSpan EchoWindow = TimeSpan.FromSeconds(5);

    public const int EchoFingerprints = 1_000;

    /// <summary>The largest payload a Publish node sends or a Webhook node posts, in bytes once encoded.</summary>
    public const int PayloadBytes = 64 * 1024;

    public const int TopicTemplateLength = 1_024;

    /// <summary>The longest topic MQTT carries, in bytes once encoded. A topic rendered longer is not published.</summary>
    public const int TopicBytes = 65_535;

    public const int NameLength = 80;

    /// <summary>The longest reason a Raise alarm node may be given, placeholders and all. What it renders is cut at <see cref="ReasonLength"/>.</summary>
    public const int ReasonTemplateLength = 1_024;

    public const int ReasonLength = 200;
    public const int SampleLength = 4_096;

    /// <summary>The note under a node on the canvas.</summary>
    public const int NoteLength = 80;

    public const int StandingShown = 20;

    /// <summary>How many flow alarms may be up at once, across every flow.</summary>
    // The alert engine's MaxActiveAlerts, and for its reasons. A filter as wide as plant/# feeding a
    // raise opens one alarm per topic, each holding a sample of up to 4 KB, and every one of them is
    // in each GET /api/alerts the console reads; without a ceiling a flow is the way round the one
    // the alert engine keeps.
    public const int StandingAlarms = 1_000;

    public const int AlarmHistory = 100;
    public const int DebugPerPush = 100;
    public const int DebugExcerpt = 1_024;

    /// <summary>The fastest the console is told what the flows are doing.</summary>
    public static readonly TimeSpan StatusEvery = TimeSpan.FromMilliseconds(250);

    // ---- the flowchart's (2026-10-03) ----

    /// <summary>How many steps one run takes in one turn of the pump before the next run gets its turn.</summary>
    // A loop of a thousand turns with no Wait in it is a thousand turns of work; taken in one go it
    // would hold up every other run, the link and the console for as long as that is.
    public const int StepsPerTurn = 1_000;

    public const long ForTimes = 1_000_000;
    public static readonly TimeSpan MinWait = TimeSpan.FromMilliseconds(100);
    public static readonly TimeSpan MaxWait = TimeSpan.FromHours(24);

    /// <summary>How many messages an MQTT in node holds for a run that has not read them yet.</summary>
    public const int QueuedMessages = 1_000;

    public const int Variables = 50;
    public const int VariableBytes = 64 * 1024;

    /// <summary>How often one Sound, Notify or Webhook node may do its job.</summary>
    // Once a second: wired to a message rather than to an alarm's "raised", any of them would
    // otherwise play, pop up or post at the rate of the plant's messages.
    public static readonly TimeSpan ChannelEvery = TimeSpan.FromSeconds(1);

    public const int NoticeLength = 200;

    /// <summary>
    /// The longest a node's text may be written, placeholders and all: a Notify's text, an If's values, For's
    /// times, Wait's seconds and Set's value, and where an If, a For each or a Raise alarm reads from.
    /// </summary>
    // Each of them is rendered or read every time a run passes the node, on the pump every flow shares, and
    // with nothing to hold them but the size of a request, one Set or Wait of half a million empty
    // placeholders cost the pump four seconds a turn — from a Test, which saves nothing and needs no save.
    // What a template fills in is held to a limit of its own where it is used.
    public const int TextTemplateLength = 1_024;

    public const int UrlLength = 2_048;
}
