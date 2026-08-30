using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>Everything one condition may look at, and nothing else.</summary>
// A readonly struct passed by 'in': one of these is built per (rule, topic) per arrival, and a
// class here would be an allocation on the hottest path in the engine. Text and Number are what
// PayloadValue made of the body; Window is null unless the rule's condition reads history.
public readonly record struct EvalContext(
    string Topic,
    string? Text,
    double? Number,
    DateTimeOffset Now,
    DateTimeOffset? LastSeen,
    TopicWindow? Window);
