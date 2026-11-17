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
/// <param name="ProfileId">
/// The saved broker this rule belongs to, by its id, or null for every broker. A rule for one
/// broker applies only while a link made from that saved broker is up; one for every broker
/// applies always, and gives way to one for the broker that is up on the same filter. Null is
/// what every rules file written before this means.
/// </param>
public record TopicColourRule(string Filter, string Colour, string? BodyColour = null, string? ProfileId = null);
