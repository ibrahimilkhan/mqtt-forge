namespace MqttForge.Api.Contracts;

/// <summary>The one thing the reconnect option can be told.</summary>
// Nullable, so that a body which never mentioned it is telling the endpoint nothing rather than
// telling it false. See ReconnectController.SetEnabled.
public sealed record ReconnectOptionDto(bool? Enabled);
