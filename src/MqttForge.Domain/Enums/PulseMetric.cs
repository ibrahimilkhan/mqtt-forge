namespace MqttForge.Domain.Enums;

/// <summary>Which number about a rhythm a rule is watching.</summary>
// Four metrics and not a free-text name, because each of them has a unit the panel prints and the
// validator checks: a count is a count, a duty is a share between nought and one, and a period
// and a width are milliseconds. A rule that could ask for 'duty' in milliseconds is a rule that
// silently never fires.
//
// Here rather than in Domain.Models, beside OutlierMethod, because that is where this union's
// other enum went and two siblings in two namespaces would make every consumer import both for no
// reason anybody could give afterwards.
public enum PulseMetric
{
    /// <summary>Separate excursions past the line, in the window.</summary>
    Count,

    /// <summary>The share of the READINGS spent past it, from 0 to 1 — never a share of the time.</summary>
    Duty,

    /// <summary>Middle time from one excursion's start to the next, in milliseconds.</summary>
    Period,

    /// <summary>Middle time an excursion lasts, in milliseconds.</summary>
    Width,
}
