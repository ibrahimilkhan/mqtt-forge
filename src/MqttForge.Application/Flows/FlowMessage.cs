namespace MqttForge.Application.Flows;

/// <summary>What a run carries from step to step.</summary>
// Three things and no more. A flow is about MQTT messages, and a message is a topic and a payload;
// Index is the one thing a flow adds: the turn of the loop the message is in, from 1, and 0 outside
// any loop. A run starts with an empty message; an MQTT in replaces its topic and payload with the
// message it reads, a For each its payload with the element, and nothing else writes to it — what a
// flow wants to keep beside the message, it keeps in a variable.
public sealed record FlowMessage(string Topic, string Payload, int Index = 0);
