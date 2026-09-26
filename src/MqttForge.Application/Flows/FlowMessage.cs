namespace MqttForge.Application.Flows;

/// <summary>What travels along a wire.</summary>
// Three things and no more. A flow is about MQTT messages, and a message is a topic and a payload;
// Index is the one thing a flow adds, because three of its nodes produce numbered copies — the
// tick of an Every, the element of a For each, the copy of a Repeat — and a publish that wants to
// say which one it is needs to read it. Everything else a node wants, it reads out of the payload.
//
// Nodes pass it on unchanged. For each is the only node that writes a new payload, and it writes
// the element, because that is what "for each" means to anyone who has written one.
public sealed record FlowMessage(string Topic, string Payload, int Index = 1);
