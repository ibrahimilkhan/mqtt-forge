using System.Text.Json.Serialization;
using MqttForge.Domain.Enums;

namespace MqttForge.Domain.Models;

/// <summary>
/// What a rule asks of a topic. A closed, recursive union: the composites hold other conditions,
/// so a rule is a tree and not a list of clauses joined by a hidden AND.
/// </summary>
// The discriminator lives on the model rather than in a converter beside the store because this
// shape is a contract in three places at once — alert-rules.json on disk, the PUT body, and
// web/src/types/api.ts — and a converter registered in only two of them is a file the third
// cannot read. It is written as "type" and read first: System.Text.Json decides which record to
// build the moment it meets the discriminator, so a hand-edited file with "type" written last
// throws, and AlertJsonShapeTests pins that so whoever loads the file catches it.
//
// [JsonPolymorphic] with no fallback is the deliberate choice over an UnknownDerivedTypeHandling
// that quietly produces the base type: an unrecognised condition is a rule from a newer build,
// and a rule nobody can evaluate has to be counted and reported, not read as an empty one.
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(ThresholdCondition), "threshold")]
[JsonDerivedType(typeof(BandCondition), "band")]
[JsonDerivedType(typeof(PatternCondition), "pattern")]
[JsonDerivedType(typeof(OneOfCondition), "oneOf")]
[JsonDerivedType(typeof(AllCondition), "all")]
[JsonDerivedType(typeof(AnyCondition), "any")]
[JsonDerivedType(typeof(SilenceCondition), "silence")]
[JsonDerivedType(typeof(OutlierCondition), "outlier")]
[JsonDerivedType(typeof(DistributionShiftCondition), "distributionShift")]
[JsonDerivedType(typeof(ShapeChangeCondition), "shapeChange")]
[JsonDerivedType(typeof(PulseCondition), "pulse")]
public abstract record AlertCondition;

/// <summary>One reading against one number.</summary>
public sealed record ThresholdCondition(ThresholdOp Op, double Value) : AlertCondition;

/// <summary>
/// A reading against a range. <paramref name="Inside"/> false asks for the complement, which is
/// the 4-20mA question — 'tell me when the line leaves its working range' — written once.
/// </summary>
// Both edges belong to the inside. A 4-20mA line at exactly 20.0 is at the top of its range and
// not out of it, and the alternative — an exclusive high edge — would make a rule fire on the one
// reading a saturated sensor produces most often.
public sealed record BandCondition(double Low, double High, bool Inside) : AlertCondition;

/// <summary>
/// The body, or the extracted field, against a regular expression.
/// <paramref name="Negate"/> asks for 'does not match'.
/// </summary>
// Regex is the pattern text and not a compiled Regex: this record is deserialised from a file
// written by a user, and a model that could only exist in a compilable state would have no way to
// carry a rule long enough to report it as broken. Compilation happens once per rule set, in
// CompiledPatterns.
public sealed record PatternCondition(string Regex, bool Negate) : AlertCondition;

/// <summary>An allow-list, or with <paramref name="Negate"/> a deny-list, of exact texts.</summary>
public sealed record OneOfCondition(IReadOnlyList<string> Values, bool Negate) : AlertCondition;

/// <summary>Every child. An empty list is true, as an empty conjunction is.</summary>
public sealed record AllCondition(IReadOnlyList<AlertCondition> Of) : AlertCondition;

/// <summary>Any child. An empty list is false, as an empty disjunction is.</summary>
public sealed record AnyCondition(IReadOnlyList<AlertCondition> Of) : AlertCondition;

/// <summary>Nothing has arrived on this topic for <paramref name="After"/> seconds.</summary>
// The only condition whose truth is about time passing rather than about a message, which is why
// it is the one condition the tick evaluates and the arrival path never does.
public sealed record SilenceCondition(int After) : AlertCondition;

/// <summary>
/// A reading that does not belong with the ones before it.
/// </summary>
// The first condition in this union whose answer depends on more than the message in hand, and
// therefore the first that needs the pair's ring. Three members and each carries a decision:
//
// Method picks which of the two fences is drawn — see OutlierMethod for why there are two.
//
// K means a different thing under each method, which is unusual enough to be worth naming: under
// tukey it multiplies the interquartile range and the sensible span is 0.5 to 5, with 1.5 the
// textbook value; under sigma it counts deviations and the sensible span is 1 to 10, with 3 the
// value every control chart in the world is drawn at. One member rather than two because it is
// one idea — how far is far enough — and a record carrying `tukeyK` and `sigmaK` would have one
// of them meaningless in every rule ever written. The validator enforces the right range for the
// method; the engine supplies the right default when the member is absent.
//
// Nought is 'not given', for K and for Window alike. The JSON omits an unset member, System.Text.
// Json binds the absence to the type's default, and neither a fence of nought times anything nor
// a window of no readings is a thing a person could mean.
//
// Window is how many of the most recent readings the fence is drawn from, 20 to 2000; absent, the
// pair's whole ring is used, which is DefaultWindow unless another condition on the same rule
// asked for more.
public sealed record OutlierCondition(OutlierMethod Method, double K, int Window) : AlertCondition;

/// <summary>
/// The window's readings stopped fitting the distribution they had settled into.
/// </summary>
// An edge and not a state: it is true from the moment a new name has been believed until that name
// has held a whole window, and it is never true twice for one change. So there is nothing here for
// 'for' to wait out, and the validator refuses the pair — the same refusal silence gets, for the
// mirror-image reason. Silence is already a duration; this is already a moment.
//
// No name is written down in the rule. A rule saying "tell me when this stops being normal" would
// need the user to know what it is now, which is the question they are asking the tool.
public sealed record DistributionShiftCondition(int Window) : AlertCondition;

/// <summary>
/// The window's readings stopped being the kind of signal they were: a quantity became a switch,
/// a switch became a pulse train.
/// </summary>
// The shape decides what may honestly be said about a topic at all — a mean is a fact about a
// temperature and a fiction about a door sensor — so a shape that changes is the plant telling
// you that the note beside this topic has been describing the wrong thing since it changed.
public sealed record ShapeChangeCondition(int Window) : AlertCondition;

/// <summary>One number about the rhythm of a signal, against one value.</summary>
// Deliberately independent of the shape. The metrics are taken from the whole window whatever
// ShapeId says about it, because a pump that has stopped pulsing is exactly the case where the
// shape has stopped being 'pulse' — and a condition that needed the shape to agree with it first
// would go quiet at the moment it was wanted.
public sealed record PulseCondition(PulseMetric Metric, ThresholdOp Op, double Value, int Window)
    : AlertCondition;
