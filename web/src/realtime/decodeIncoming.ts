import { byteLength, hexFromBase64, type BodyMode } from '../lib/payload';
import type { MqttMessage } from '../types/api';

/** An arrival as the rest of the app holds it: a body to show, and how that body is written. */
export type DecodedMessage = {
  topic: string;
  payload: string;
  mode: BodyMode;
  /** Bytes on the wire — the hex text above is two characters per byte. */
  size: number;
  qos: number;
  retain: boolean;
  receivedAt: string;
};

/**
 * The one place base64 is understood on the way in. The log and the topic tree are both fed
 * from here, so neither has to know the wire carries two kinds of body.
 */
export function decodeIncoming(message: MqttMessage): DecodedMessage {
  const { topic, qos, retain, receivedAt } = message;

  if (message.payloadEncoding === 'base64') {
    const { text, size } = hexFromBase64(message.payload);
    return { topic, payload: text, mode: 'hex', size, qos, retain, receivedAt };
  }

  return {
    topic,
    payload: message.payload,
    mode: 'text',
    size: byteLength(message.payload),
    qos,
    retain,
    receivedAt,
  };
}
