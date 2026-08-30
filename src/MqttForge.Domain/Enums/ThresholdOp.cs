namespace MqttForge.Domain.Enums;

// The six comparisons a threshold can make. Eq and Neq are here despite being an odd thing to
// ask of a floating-point reading, because the payloads this tool sees are not all measurements:
// a setpoint echo, a mode number and a fault code are all bodies a user will want to test for
// exactly, and telling them to write a band of zero width instead would be a worse answer.
public enum ThresholdOp
{
    Gt,
    Gte,
    Lt,
    Lte,
    Eq,
    Neq
}
