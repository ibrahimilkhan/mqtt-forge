namespace MqttForge.Domain.Enums;

/// <summary>
/// What one condition made of one arrival. Three-valued: a condition that could not be evaluated
/// is <see cref="Skipped"/>, never <see cref="False"/>.
/// </summary>
// The third value is the whole point of this type existing instead of a bool. A rule reading
// '< 10' against a device that says 'warming up' has not seen a reading below ten; it has seen no
// reading at all, and a bool forces that into False, which for a Clear condition means an alert
// silently going away while the plant is still on fire. The spec's 'Eksik veri değerlendirilmez,
// yanlış sayılmaz' is this enum.
public enum Verdict
{
    True,
    False,
    Skipped
}
