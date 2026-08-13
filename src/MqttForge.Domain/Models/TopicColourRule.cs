namespace MqttForge.Domain.Models;

/// <summary>
/// One user-chosen colour for the topics an MQTT filter covers. Carries no order: which rule wins
/// when several match a topic is decided by how specific the filter is, not where it sits.
/// </summary>
public record TopicColourRule(string Filter, string Colour);
