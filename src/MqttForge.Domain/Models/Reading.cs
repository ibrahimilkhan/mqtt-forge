namespace MqttForge.Domain.Models;

/// <summary>
/// One reading in a rule's window: when it arrived, and what it said.
/// </summary>
// A readonly record struct, and that is load-bearing rather than a matter of taste.
//
// The ring holds these in a plain Reading[], so a window of two hundred is one array of 3.2 kB
// and nothing else — no object header per reading, no reference for the collector to chase, and
// nothing to collect at all when the ring wraps and writes over its own oldest entry. A class
// here would cost one allocation per arrival, forty-odd bytes each with its header, and would
// turn the ring into an array of pointers into a heap that has to be walked.
//
// The sixteen bytes are what the spec's Sayılar table does its arithmetic in: the ring budget is
// written as 4 000 000 readings ≈ 64 MB, and that equality holds only while this type is a long
// and a double side by side. Adding a field — the raw text, a quality flag — changes the memory
// ceiling of the whole engine, so it is not a free change and should not be made quietly.
//
// Ticks are MqttMessage.ReceivedAt.UtcTicks and never the pump's own clock. The spec keeps two
// clocks apart on purpose: a burst waiting in the queue must not be squashed into the moment the
// pump drained it, or 'pulse' would measure the pump's cadence instead of the device's.
//
// 'readonly' so the copies the ring makes cannot surprise anyone, and 'record' for Equals and
// ToString — which is the whole difference between a readable window assertion and a page of
// hex.
public readonly record struct Reading(long Ticks, double Value);
