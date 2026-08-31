namespace MqttForge.Domain.Enums;

/// <summary>
/// How a run decides that one reading does not belong to it.
/// </summary>
// Two, not one, because they fail on opposite kinds of run and a tool that offered only one would
// be wrong about half the sensors in a plant. Tukey works off the quartiles, so a run with a few
// wild readings already in it still has a sensible box to measure against — but it needs a run
// with some width to it. Sigma works off the mean and the deviation, which is what a physicist
// asks for on an instrument whose noise is genuinely normal, and which the same few wild readings
// pull about badly.
//
// The words are the wire format: "tukey" and "sigma" in alert-rules.json and in the PUT body,
// through the camelCase enum converter both sides share.
public enum OutlierMethod
{
    Tukey,
    Sigma
}
