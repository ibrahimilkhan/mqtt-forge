namespace MqttForge.Domain.Enums;

// Which MQTT the console speaks to a broker. The wire numbers are the protocol levels the
// CONNECT packet carries, so the enum can be read straight off a packet capture.
//
// Auto is not a version — it is the instruction to find one. It exists because the answer a
// broker gives to the wrong version is not a sentence anybody can act on: some send a CONNACK
// naming the problem, most simply close the socket, and a reader looking at "the broker did not
// respond" has no way to guess that the fix is a number they have never heard of.
public enum MqttProtocolLevel
{
    // Try 5.0, then 3.1.1, then 3.1, and keep the first one that is accepted.
    Auto = 0,

    // MQTT 3.1. Protocol name MQIsdp, client ids capped at 23 bytes by the specification.
    V310 = 3,

    // MQTT 3.1.1, the OASIS standard and still the commonest thing on a broker.
    V311 = 4,

    // MQTT 5.0: reason codes with meanings, session expiry, and properties on every packet.
    V500 = 5
}
