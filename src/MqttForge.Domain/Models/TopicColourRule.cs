namespace MqttForge.Domain.Models;

/// <summary>
/// One user-chosen colour for the topics an MQTT filter covers. Carries no order: which rule wins
/// when several match a topic is decided by how specific the filter is, not where it sits.
/// </summary>
/// <param name="Filter">The MQTT filter whose topics wear this rule.</param>
/// <param name="Colour">What the topic itself is drawn in.</param>
/// <param name="BodyColour">
/// What the message under the topic is drawn in, or null to leave it in the console's own ink.
/// Optional because that is the honest default: a reader who wants a topic told apart in a
/// scrolling log usually wants the path coloured and the payload left legible, and every rules
/// file written before this existed means exactly that.
/// </param>
public record TopicColourRule(string Filter, string Colour, string? BodyColour = null);
