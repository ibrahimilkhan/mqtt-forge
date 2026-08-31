using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>Everything one condition may look at, and nothing else.</summary>
// A readonly struct passed by 'in': one of these is built per (rule, topic) per arrival, and a
// class here would be an allocation on the hottest path in the engine. Text and Number are what
// PayloadValue made of the body; Window is null unless the rule's condition reads history.
//
// State is the pair itself, and it is last and defaulted for two reasons. Defaulted, so that every
// construction of this struct that already exists — the two in ConditionEvaluatorTests included —
// goes on compiling untouched. Present at all, because a condition that reads history soon needs
// more of the pair than its ring: what the run behind it was last judged to be, and when it was
// last looked at. Nothing in this task reads it. It is set here and now, in the one place an
// arrival context is built, rather than attached further down the call chain by the task that
// needs it — this is a struct taken by 'in', so a callee writing `context with { State = … }`
// would be writing to its own copy, and the caller's Describe would go on reading a null.
public readonly record struct EvalContext(
    string Topic,
    string? Text,
    double? Number,
    DateTimeOffset Now,
    DateTimeOffset? LastSeen,
    TopicWindow? Window,
    RuleState? State = null);
