using MqttForge.Application.Alerts;

namespace MqttForge.Application.Flows.Next;

/// <summary>For's times and Wait's seconds, read from what a box held or a template rendered.</summary>
// One reading for the compiler, which judges what was typed, and the runtime, which judges what a
// variable held when the run got there: a number the compiler accepts is never one a run refuses.
public static class FlowNumbers
{
    public static long? Times(string text) =>
        PayloadValue.AsReading(text) is { } times && times >= 0 && times <= FlowLimits.ForTimes && times == Math.Floor(times)
            ? (long)times
            : null;

    public static TimeSpan? Seconds(string text) =>
        PayloadValue.AsReading(text) is { } seconds &&
        seconds >= FlowLimits.MinWait.TotalSeconds && seconds <= FlowLimits.MaxWait.TotalSeconds
            ? TimeSpan.FromSeconds(seconds)
            : null;
}
