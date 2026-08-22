namespace MqttForge.Domain.Enums;

// What carries the MQTT packets. Encryption is not part of this: it is a separate flag on the
// settings, because the four combinations people name mqtt/mqtts/ws/wss are exactly these two
// transports crossed with that one flag, and splitting them keeps every place that already asks
// "was this connection encrypted" — the saved settings, a failure, a live link — unchanged.
public enum MqttTransport
{
    // MQTT straight over a socket. Ports 1883 and 8883 by convention.
    Tcp = 0,

    // MQTT inside a WebSocket, which is how a broker behind an HTTP reverse proxy or a corporate
    // firewall is usually reached. Needs a path as well as a port; nearly every broker uses
    // /mqtt, and the ones that do not are the reason the path is a field.
    WebSocket = 1
}
