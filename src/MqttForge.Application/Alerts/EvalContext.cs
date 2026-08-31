using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>Everything one condition may look at, and nothing else.</summary>
// A readonly struct passed by 'in': one of these is built per (rule, topic) per arrival, and a
// class here would be an allocation on the hottest path in the engine. Text and Number are what
// PayloadValue made of the body; Window is null unless the rule's condition reads history.
//
// State is the pair itself, and it is here for the two statistical conditions that have a memory:
// what this topic's readings have settled into is a fact about the pair, not about the message,
// and there is nowhere else for it to live. Appended last and defaulted to null, exactly as
// MqttMessage.Replay was, so every existing construction — the two in the core and every one in
// the tests — goes on compiling and goes on meaning what it meant.
//
// It is set at the two places a context is built, OnMatch and Blank, and deliberately not inside
// EvaluateGuarded. That was the first shape and it cannot work: EvaluateGuarded takes the context
// 'in', so a 'context with { State = state }' written there is a local copy only the evaluator
// sees. OnArrival then hands ReasonFor the caller's own context, whose State is still null, and
// Describe prints the nameless fallback — "the readings changed distribution" — on every alert
// this task raises, at the exact moment the two names are the news.
public readonly record struct EvalContext(
    string Topic,
    string? Text,
    double? Number,
    DateTimeOffset Now,
    DateTimeOffset? LastSeen,
    TopicWindow? Window,
    RuleState? State = null);
